import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("poller keeps reading and updating status while only publishing changed FBs", { timeout: 5000 }, async (t) => {
  let reads = 0;
  let connections = 0;
  const messages = [];
  const makeCycleValues = (base, cycle_counter = 0) => ({
    timestamp_DO_MCtrl14_ON: String(base),
    timestamp_DO_MCtrl12_OFF: String(base),
    timestamp_DI_IPos_OFF: String(base + 15),
    timestamp_DI_EPos_ON: String(base + 50),
    timestamp_DO_MCtrl12_ON: String(base + 65),
    timestamp_DO_MCtrl14_OFF: String(base + 65),
    timestamp_DI_EPos_OFF: String(base + 80),
    timestamp_DI_IPos_ON: String(base + 110),
    cycle_counter,
    part_number: "part",
  });
  const blocks = [0, 1].map((index) => ({
    index, startAddress: index * 58, registerCount: 58, topic: `fb/${index + 1}`,
    values: makeCycleValues(1000, 0),
  }));
  t.mock.module(new URL("../server/mqttPublisher.js", import.meta.url).href, {
    namedExports: {
      publishPayload: async (_mqtt, topic, values) => {
        messages.push({ topic, values: structuredClone(values) });
        return true;
      },
    },
  });
  t.mock.module(new URL("../server/plc/modbusClient.js", import.meta.url).href, {
    namedExports: {
      normalizeModbusConfig: (config) => structuredClone(config),
      connectModbus: async (config) => { connections++; return { client: { isOpen: true }, config }; },
      disconnectModbus: async (client) => { if (client) client.isOpen = false; },
      modbusErrorMessage: (error) => error.message,
      readModbusDatablocks: async () => { reads++; return structuredClone(blocks); },
      readModbusRegisters: async () => [{ name: "counter", value: 10 }],
      readModbusSample: async () => structuredClone(blocks),
      testModbusConnection: async () => { throw new Error("Unexpected extra PLC connection"); },
    },
  });
  const { startModbusPoller, stopModbusPoller, getModbusPollerStatus, testModbusPollerConnection } =
    await import("../server/plc/modbusPoller.js");
  const config = {
    id: "test-plc", host: "plc", port: 502, unitId: 1, timeout: 1000,
    polling: 10, readMode: "Read by Datablocks",
    mqtt: { host: "broker", port: 1883 },
  };
  t.after(() => stopModbusPoller(config.id));
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Timed out waiting for a polling round");
      await delay(5);
    }
  };

  await startModbusPoller(config);
  assert.equal(messages.length, 2);
  assert.equal(getModbusPollerStatus(config.id).dataBlocks[0]?.lastDataUpdatedAt, null);
  assert.equal(typeof getModbusPollerStatus(config.id).dataBlocks[0]?.firstSeenAt, "number");
  assert.equal(getModbusPollerStatus(config.id).dataBlocks[0]?.updateCount, 0);
  blocks[0].values.cycle_counter = 25;
  await waitFor(() => getModbusPollerStatus(config.id).dataBlocks[0]?.values.cycle_counter === 25);
  assert.ok(reads >= 2);
  assert.equal(messages.length, 2);
  assert.equal(getModbusPollerStatus(config.id).pollingStatus, "HEALTHY");
  assert.equal(typeof getModbusPollerStatus(config.id).dataBlocks[0]?.lastDataUpdatedAt, "number");
  assert.equal(getModbusPollerStatus(config.id).dataBlocks[0]?.updateCount, 1);
  assert.equal(getModbusPollerStatus(config.id).dataBlocks[1]?.lastDataUpdatedAt, null);
  assert.equal(getModbusPollerStatus(config.id).dataBlocks[1]?.updateCount, 0);

  blocks[1].values = makeCycleValues(2000, 1);
  await waitFor(() => messages.length === 3);
  assert.equal(messages[2].topic, "fb/2");
  await startModbusPoller({ ...config, polling: 20 });
  assert.equal(messages.length, 3, "Save/Rescan must preserve the last published timestamps");
  assert.equal(connections, 1);
  await testModbusPollerConnection(config);
  assert.equal(messages.length, 3, "Connection tests must not publish");

  await startModbusPoller({ ...config, readMode: "Read by registers" });
  assert.equal(messages.length, 4);
  await startModbusPoller(config);
  assert.equal(messages.length, 6, "Returning to datablocks starts a new baseline");
  await stopModbusPoller(config.id);
  await startModbusPoller(config);
  assert.equal(messages.length, 8, "Restarted acquisition sends fresh snapshots");
  await startModbusPoller({ ...config, endian: "Little-Endian" });
  assert.equal(messages.length, 10, "Changing endian republishes even if timestamps match");
  await startModbusPoller({ ...config, endian: "Little-Endian" });
  assert.equal(messages.length, 10, "Saving unchanged endian preserves the baseline");
  const testConfig = { ...config, endian: "Little-Endian", testMode: true };
  await startModbusPoller(testConfig);
  const afterEnabling = messages.length;
  await waitFor(() => messages.length >= afterEnabling + 4);
  assert.equal(connections, 2, "Test mode reuses the current TCP connection");
  await startModbusPoller({ ...testConfig, testMode: false });
  const afterDisabling = messages.length;
  const readsAfterDisabling = reads;
  await waitFor(() => reads >= readsAfterDisabling + 2);
  assert.equal(messages.length, afterDisabling, "Normal polling resumes suppressing unchanged timestamps");
});
