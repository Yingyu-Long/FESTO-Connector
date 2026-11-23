import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeModbusConfig, readModbusDatablocks, readModbusRegisters, readModbusSample } from "../server/plc/modbusClient.js";

function makeCycleWords(base, cycleCounter = 1, part = "CYL-001") {
  const words = new Array(58).fill(0);
  const putU64 = (start, val) => {
    const v = BigInt(val);
    for (let i = 0; i < 4; i++) {
      words[start + i] = Number((v >> BigInt(48 - i * 16)) & 0xffffn);
    }
  };
  const b = BigInt(base);
  putU64(0, b + 110n); // timestamp_DI_IPos_ON
  putU64(4, b + 15n);  // timestamp_DI_IPos_OFF
  putU64(8, b + 50n);  // timestamp_DI_EPos_ON
  putU64(12, b + 80n); // timestamp_DI_EPos_OFF
  putU64(16, b + 65n); // timestamp_DO_MCtrl12_ON
  putU64(20, b);       // timestamp_DO_MCtrl12_OFF
  putU64(24, b);       // timestamp_DO_MCtrl14_ON
  putU64(28, b + 65n); // timestamp_DO_MCtrl14_OFF
  words[32] = (cycleCounter >>> 16) & 0xffff;
  words[33] = cycleCounter & 0xffff;
  const buf = Buffer.alloc(48, 0);
  Buffer.from(part, "ascii").copy(buf, 0, 0, 48);
  for (let i = 0; i < 24; i++) {
    words[34 + i] = (buf[i * 2] << 8) | buf[i * 2 + 1];
  }
  return words;
}

test("auto-restores saved Modbus pollers from DB, self-heals offline PLCs, hot-reloads MQTT, and syncs replacements", { timeout: 5000 }, async (t) => {
  const messages = [];
  let plcOffline = true;
  let connectCount = 0;
  let currentWords = makeCycleWords(1000, 1);

  t.mock.module(new URL("../server/mqttPublisher.js", import.meta.url).href, {
    namedExports: {
      publishPayload: async (mqtt, topic, payload) => {
        if (!mqtt?.host) return false;
        messages.push({ host: mqtt.host, port: Number(mqtt.port), topic, payload: structuredClone(payload) });
        return true;
      },
      testMqttConnection: async () => true,
      closeAllMqttClients: () => undefined,
    },
  });

  t.mock.module(new URL("../server/plc/modbusClient.js", import.meta.url).href, {
    namedExports: {
      normalizeModbusConfig,
      readModbusDatablocks,
      readModbusRegisters,
      readModbusSample,
      modbusErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      connectModbus: async (config) => {
        connectCount++;
        if (plcOffline) throw new Error("ECONNREFUSED");
        return {
          config,
          client: {
            isOpen: true,
            setID: () => undefined,
            setTimeout: () => undefined,
            readHoldingRegisters: async (_addr, count) => ({ data: currentWords.slice(0, count) }),
          },
        };
      },
      disconnectModbus: async (client) => {
        if (client) client.isOpen = false;
      },
    },
  });

  const {
    getModbusPollerStatus,
    listActiveModbusPollers,
    stopAllModbusPollers,
  } = await import("../server/plc/modbusPoller.js");
  const {
    extractMqttConfigFromConfiguration,
    restoreModbusPollersFromDatabase,
    syncModbusPollersWithConfiguration,
  } = await import("../server/plc/modbusBootstrap.js");

  t.after(async () => {
    await stopAllModbusPollers();
  });

  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, `Timed out waiting for: ${label}`);
      await delay(10);
    }
  };

  // Empty/placeholder MQTT URI from unconfigured UI returns undefined cleanly
  assert.equal(
    extractMqttConfigFromConfiguration({ mqttMessageHandler: { uri: "tcp://:1883" } }),
    undefined,
  );

  const savedConfiguration = {
    id: "cfg-1",
    mqttMessageHandler: {
      clientId: "connector-1",
      uri: "tcp://broker-a:1883",
      qos: 1,
      anonymousAuthentication: {},
    },
    messageSources: [
      {
        id: "plc-66",
        uri: "modbus.tcp://10.0.0.10:1502",
        uniqueKey: "modbus.tcp-plc-66",
        configuration: {
          readMode: "Read by Datablocks",
          layoutMode: "standard",
          endian: "Big-Endian",
          startAddress: "0",
          registerCount: "1",
          blockTopics: ["cyl/1"],
          unitId: "1",
          timeout: "1000",
          polling: "25",
          testMode: false,
        },
      },
    ],
  };

  // 1. Cold-boot restore retries transient DB failure and keeps initially-offline PLC alive for auto-recovery.
  let dbCalls = 0;
  const restoreResult = await restoreModbusPollersFromDatabase({
    queryFn: async () => {
      dbCalls++;
      if (dbCalls === 1) throw new Error("DB booting");
      return { rows: [{ configuration: savedConfiguration }] };
    },
    retryAttempts: 3,
    retryDelayMs: 20,
    pollerOptions: { retryIntervalMs: 30 },
  });

  assert.equal(dbCalls, 2, "must retry database query during cold boot");
  assert.equal(restoreResult.restored, true);
  assert.equal(restoreResult.summary.started, 1);
  assert.equal(listActiveModbusPollers().length, 1);
  assert.equal(getModbusPollerStatus("plc-66").pollingStatus, "UNHEALTHY");
  assert.equal(messages.length, 0);

  // 2. PLC powers on -> background poller automatically recovers to HEALTHY and publishes without manual Rescan!
  plcOffline = false;
  await waitFor(
    () => getModbusPollerStatus("plc-66").pollingStatus === "HEALTHY" && messages.length === 1,
    "auto-recovery when PLC comes online",
  );
  assert.equal(messages[0].host, "broker-a");
  assert.equal(messages[0].topic, "cyl/1");
  assert.equal(messages[0].payload.part_number, "CYL-001");

  // 3. Re-saving identical configuration (e.g. PUT /api/configuration right after Save) is a zero-cost no-op.
  const connectionsBefore = connectCount;
  const noopSummary = await syncModbusPollersWithConfiguration(savedConfiguration);
  assert.equal(noopSummary.unchanged, 1);
  assert.equal(noopSummary.started, 0);
  assert.equal(noopSummary.updated, 0);
  assert.equal(noopSummary.mqttUpdated, 0);
  assert.equal(connectCount, connectionsBefore, "must not reconnect on unchanged config");

  // 4. Updating MQTT broker hot-reloads running poller in place and publishes a snapshot to the new broker.
  const updatedMqttConfig = {
    ...savedConfiguration,
    mqttMessageHandler: {
      clientId: "connector-1",
      uri: "tcp://broker-b:1884",
      qos: 1,
      basicAuthentication: { username: "u", password: "p" },
    },
  };
  const mqttSummary = await syncModbusPollersWithConfiguration(updatedMqttConfig);
  assert.equal(mqttSummary.mqttUpdated, 1);
  assert.equal(connectCount, connectionsBefore, "MQTT update must preserve existing Modbus TCP socket");

  await waitFor(
    () => messages.some((m) => m.host === "broker-b" && m.port === 1884),
    "hot-reloaded MQTT delivery to broker-b",
  );

  // 5. Importing a new configuration replaces the PLC list: stops removed pollers and starts new ones.
  currentWords = makeCycleWords(3000, 2, "CYL-002");
  const importedConfig = {
    ...updatedMqttConfig,
    messageSources: [
      {
        id: "plc-port-1503",
        uri: "modbus.tcp://10.0.0.10:1503",
        uniqueKey: "modbus.tcp-plc-port-1503",
        configuration: {
          readMode: "Read by Datablocks",
          layoutMode: "standard",
          endian: "Big-Endian",
          startAddress: "0",
          registerCount: "1",
          blockTopics: ["cyl/new"],
          unitId: "1",
          timeout: "1000",
          polling: "50",
        },
      },
    ],
  };
  const importSummary = await syncModbusPollersWithConfiguration(importedConfig);
  assert.equal(importSummary.stopped, 1, "removed PLC poller must be stopped");
  assert.equal(importSummary.started, 1, "imported PLC poller must be started");
  assert.equal(getModbusPollerStatus("plc-66").pollingStatus, "NOT_CONNECTED");
  assert.equal(getModbusPollerStatus("plc-port-1503").pollingStatus, "HEALTHY");
  assert.equal(messages.at(-1).topic, "cyl/new");
  assert.equal(messages.at(-1).payload.part_number, "CYL-002");
});
