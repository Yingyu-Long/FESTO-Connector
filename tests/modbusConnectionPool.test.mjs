import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeModbusConfig, readModbusDatablocks, readModbusSample, readModbusRegisters } from "../server/plc/modbusClient.js";

test("shared transport serializes tests and acquisitions, restores Unit IDs, and survives release/reconnect", { timeout: 5000 }, async (t) => {
  let connections = 0;
  let closes = 0;
  let inFlight = 0;
  let failRead = false;
  let exceptionRead = false;
  const reads = [];
  const messages = [];
  let releaseClose;
  let onClose;
  t.mock.module(new URL("../server/plc/modbusClient.js", import.meta.url).href, {
    namedExports: {
      normalizeModbusConfig, readModbusDatablocks, readModbusSample, readModbusRegisters,
      modbusErrorMessage: (error) => error.message,
      connectModbus: async (config) => {
        connections++;
        const client = {
          isOpen: true, unitId: config.unitId, timeout: config.timeout,
          setID(value) { this.unitId = value; },
          setTimeout(value) { this.timeout = value; },
          async readHoldingRegisters(address, count) {
            assert.equal(inFlight++, 0, "no overlapping requests on a shared socket");
            const unitId = this.unitId;
            const timeout = this.timeout;
            try {
              await delay(3);
              assert.equal(this.unitId, unitId, "Unit ID cannot change during a request");
              reads.push({ address, count, unitId, timeout });
              if (exceptionRead) { exceptionRead = false; throw { message: "Illegal address", modbusCode: 2 }; }
              if (failRead) { failRead = false; throw new Error("Socket disconnected"); }
              return { data: Array(count).fill(unitId) };
            } finally { inFlight--; }
          },
        };
        return { config, client };
      },
      disconnectModbus: async (client) => {
        if (!client?.isOpen) return;
        assert.equal(inFlight, 0, "close waits for in-flight reads");
        closes++; client.isOpen = false;
        if (onClose) {
          const notify = onClose; onClose = undefined;
          await new Promise((resolve) => { releaseClose = resolve; notify(); });
        }
      },
    },
  });
  t.mock.module(new URL("../server/mqttPublisher.js", import.meta.url).href, {
    namedExports: { publishPayload: async (_mqtt, topic, payload) => { messages.push({ topic, payload }); return true; } },
  });
  const { startModbusPoller, stopModbusPoller, testModbusPollerConnection, getModbusPollerStatus } = await import("../server/plc/modbusPoller.js");
  const config = {
    id: "standard", host: "plc", port: 502, unitId: 1, timeout: 1000, polling: 3600000,
    readMode: "Read by Datablocks", startAddress: 0, registerCount: 1, blockTopics: ["standard/fb"],
  };
  const custom = { ...config, id: "custom", layoutMode: "custom", unitId: 2, timeout: 2000,
    fields: [{ name: "customValue", dataType: "UINT", bitWidth: 16 }], blockTopics: ["custom/fb"] };
  t.after(async () => { await stopModbusPoller(config.id); await stopModbusPoller(custom.id); });
  // Keep one ordinary register acquisition active throughout custom tests.
  const legacyRegisters = { ...config, readMode: "Read by registers", registers: [{ name: "oldValue", address: 0, registerType: "Holding register", dataType: "UInt16" }], mqttTopic: "standard/register" };
  await startModbusPoller(legacyRegisters);
  await startModbusPoller(custom);
  assert.equal(connections, 1);
  assert.deepEqual(messages.at(-1).payload, { customValue: 2 });
  const beforeTest = messages.length;
  const results = await Promise.all([
    testModbusPollerConnection({ ...custom, unitId: 3 }),
    testModbusPollerConnection({ ...custom, unitId: 4, timeout: 4000 }),
    testModbusPollerConnection(legacyRegisters),
  ]);
  assert.equal(results[0][0].values.customValue, 3);
  assert.equal(results[1][0].values.customValue, 4);
  assert.equal(results[2].value, 1);
  assert.equal(messages.length, beforeTest, "tests do not publish");
  assert.equal(connections, 1);
  await startModbusPoller(custom);
  assert.equal(messages.at(-1).payload.customValue, 2, "testing does not change acquisition config");
  assert.equal(reads.at(-1).timeout, 2000);
  await assert.rejects(startModbusPoller({ ...custom, fields: [] }));
  assert.equal(getModbusPollerStatus(custom.id).pollingStatus, "HEALTHY");

  exceptionRead = true;
  await assert.rejects(testModbusPollerConnection({ ...custom, startAddress: 123 }), { modbusCode: 2 });
  assert.equal(closes, 0, "a Modbus exception is not a broken TCP connection");
  await testModbusPollerConnection(legacyRegisters);
  assert.equal(connections, 1);

  // Stopping while another subscriber reads cannot close its socket.
  await Promise.all([stopModbusPoller(custom.id), testModbusPollerConnection(legacyRegisters)]);
  assert.equal(closes, 0);
  failRead = true;
  await assert.rejects(testModbusPollerConnection(legacyRegisters), /Socket disconnected/);
  await testModbusPollerConnection(legacyRegisters);
  assert.equal(connections, 2, "later reads reconnect after transport failure");
  assert.equal(closes, 1);
  await stopModbusPoller(config.id);
  assert.equal(closes, 2);

  // Acquire while the final release is closing: do not remove a re-acquired
  // session from the pool or create two sockets for the same endpoint.
  const { acquireModbusConnection } = await import("../server/plc/modbusConnectionPool.js");
  const normalized = normalizeModbusConfig(custom);
  const first = acquireModbusConnection(normalized);
  await first.run(normalized, (client) => client.readHoldingRegisters(0, 1));
  const closing = new Promise((resolve) => { onClose = resolve; });
  const release = first.release();
  await closing;
  const second = acquireModbusConnection(normalized);
  releaseClose(); await release;
  await second.run(normalized, (client) => client.readHoldingRegisters(0, 1));
  const count = connections;
  const third = acquireModbusConnection(normalized);
  await third.run(normalized, (client) => client.readHoldingRegisters(0, 1));
  assert.equal(connections, count, "re-acquired session remains discoverable");
  await second.release(); await third.release();
});
