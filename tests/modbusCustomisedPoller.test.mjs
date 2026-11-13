import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeModbusConfig, readModbusDatablocks, readModbusSample } from "../server/plc/modbusClient.js";

test("custom poller sends exact dynamic MQTT payloads, reuses connections, and isolates legacy IDs", { timeout: 5000 }, async (t) => {
  const messages = [];
  let customConnections = 0;
  let reads = 0;
  let words = [0, 7, 0x4142];
  t.mock.module(new URL("../server/mqttPublisher.js", import.meta.url).href, {
    namedExports: { publishPayload: async (_mqtt, topic, payload) => {
      messages.push({ topic, payload: JSON.parse(JSON.stringify(payload)) });
      return true;
    } },
  });
  t.mock.module(new URL("../server/plc/modbusClient.js", import.meta.url).href, {
    namedExports: {
      disconnectModbus: async (client) => { if (client) client.isOpen = false; },
      modbusErrorMessage: (error) => error.message,
      normalizeModbusConfig,
      connectModbus: async (config) => {
        customConnections++;
        return { config, client: { isOpen: true, readHoldingRegisters: async (_address, count) => {
          reads++;
          return { data: words.slice(0, count) };
        } } };
      },
      readModbusRegisters: async () => [{ name: "legacy", value: 99 }],
      readModbusDatablocks, readModbusSample,
    },
  });
  const custom = await import("../server/plc/modbusCustomisedPoller.js");
  const legacy = await import("../server/plc/modbusPoller.js");
  const config = {
    id: "same-id", host: "plc", port: 502, unitId: 1, timeout: 1000, polling: 10,
    startAddress: 0, blockCount: 1, blockTopics: ["custom/test"],
    fields: [{ name: "udiCycleCounter", dataType: "UDINT", bitWidth: 32 }, { name: "sPartnumber", dataType: "STRING", bitWidth: 16 }],
    mqtt: { host: "broker", port: 1883 },
  };
  t.after(async () => {
    await custom.stopCustomisedModbusPoller(config.id);
    await legacy.stopModbusPoller(config.id);
  });
  await legacy.startModbusPoller({ ...config, polling: 3600000, readMode: "Read by registers", registers: [{ name: "legacy", registerType: "Holding register", dataType: "UInt16", address: 0 }], mqttTopic: "legacy/test" });
  await custom.startCustomisedModbusPoller(config);
  const deadline = Date.now() + 1000;
  while (messages.filter((message) => message.topic === "custom/test").length < 3) {
    assert.ok(Date.now() < deadline);
    await delay(5);
  }
  assert.ok(reads >= 3);
  assert.deepEqual(messages.filter((message) => message.topic === "custom/test")[0].payload, { udiCycleCounter: 7, sPartnumber: "AB" });
  assert.equal(legacy.getModbusPollerStatus(config.id).pollingStatus, "HEALTHY");

  const nextConfig = { ...config, polling: 3600000,
    fields: [{ name: "renamed", dataType: "ULINT", bitWidth: 64 }], blockTopics: ["custom/renamed"] };
  words = [65535, 65535, 65535, 65535];
  await custom.startCustomisedModbusPoller(nextConfig);
  assert.deepEqual(messages.at(-1), { topic: "custom/renamed", payload: { renamed: "18446744073709551615" } });
  assert.equal(customConnections, 1, "legacy and custom subscriptions share one socket");
  const messageCount = messages.length;
  const sample = await custom.testCustomisedModbusPollerConnection(nextConfig);
  assert.deepEqual(sample[0].values, { renamed: "18446744073709551615" });
  assert.equal(messages.length, messageCount, "test reads never publish");
  await assert.rejects(custom.startCustomisedModbusPoller({ ...nextConfig, fields: [] }));
  assert.equal(custom.getCustomisedModbusPollerStatus(config.id).pollingStatus, "HEALTHY");
  await custom.stopCustomisedModbusPoller(config.id);
  assert.equal(custom.getCustomisedModbusPollerStatus(config.id).pollingStatus, "NOT_CONNECTED");
  assert.equal(legacy.getModbusPollerStatus(config.id).pollingStatus, "HEALTHY", "stopping custom must leave the same legacy ID running");
});
