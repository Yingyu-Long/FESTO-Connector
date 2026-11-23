import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

test("mqttPublisher deduplicates concurrent connects, times out fast, and enforces publish timeout", { timeout: 5000 }, async (t) => {
  let connectCalls = 0;
  let endedClients = 0;
  let mode = "connect-slow";

  const mockMqtt = {
    connect(_url, _options) {
      connectCalls++;
      const client = new EventEmitter();
      client.connected = false;
      client.end = () => {
        endedClients++;
        client.connected = false;
      };
      client.publish = (topic, _msg, _opts, cb) => {
        if (mode === "publish-hang") return;
        setImmediate(() => cb(null));
      };

      if (mode === "connect-slow") {
        setTimeout(() => {
          client.connected = true;
          client.emit("connect");
        }, 30);
      }
      // In "connect-hang" mode, neither connect nor error fires.
      return client;
    },
  };

  t.mock.module("mqtt", { defaultExport: mockMqtt });
  const { publishPayload } = await import("../server/mqttPublisher.js");

  // 1. 66 concurrent publishes share a single MQTT connection attempt.
  const config = { host: "broker-1", port: 1883, qos: 1, connectTimeout: 500, publishTimeout: 500 };
  const results = await Promise.all(
    Array.from({ length: 66 }, (_, i) => publishPayload(config, `cyl/${i + 1}`, { i })),
  );
  assert.equal(results.every(Boolean), true);
  assert.equal(connectCalls, 1, "66 concurrent publishes must open only 1 MQTT connection");

  // 2. Unreachable/hanging broker fails fast once for all 66 concurrent callers instead of 66x serial timeout.
  mode = "connect-hang";
  const badConfig = { host: "broker-down", port: 1883, qos: 1, connectTimeout: 500, publishTimeout: 500 };
  const startedAt = Date.now();
  const settled = await Promise.allSettled(
    Array.from({ length: 66 }, (_, i) => publishPayload(badConfig, `cyl/${i + 1}`, { i })),
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(settled.every((r) => r.status === "rejected"), true);
  assert.match(settled[0].reason.message, /timed out/);
  assert.equal(connectCalls, 2, "66 concurrent calls to a down broker must only attempt 1 connection");
  assert.equal(endedClients, 1, "timed-out client must be disposed cleanly");
  assert.ok(elapsed < 1500, `expected fail-fast near 500ms, took ${elapsed}ms`);

  // 3. Stalled QoS 1 PUBACK rejects after publishTimeout instead of hanging forever.
  mode = "publish-hang";
  await assert.rejects(
    publishPayload(config, "cyl/hang", { ok: true }),
    /MQTT publish timed out/,
  );
});
