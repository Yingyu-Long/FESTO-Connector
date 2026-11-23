import { acquireModbusConnection } from "./modbusConnectionPool.js";
import { publishPayload } from "../mqttPublisher.js";
import { recordDiagnosticEvent } from "../debugBot/diagnosticLog.js";
import { createModbusDatablockPublisher } from "./modbusDatablockPublisher.js";
import {
  modbusErrorMessage,
  normalizeModbusConfig,
  readModbusDatablocks,
  readModbusRegisters,
  readModbusSample,
} from "./modbusClient.js";

const activePollers = new Map();
const pollingStatuses = new Map();
const OFFLINE_RETRY_MIN_MS = 2000;
const OFFLINE_RETRY_MAX_MS = 10000;

function sameConnection(first, second) {
  return first.host.toLowerCase() === second.host.toLowerCase() && first.port === second.port;
}

function pollerKey(plcId, namespace) { return JSON.stringify([namespace, String(plcId)]); }

export function listActiveModbusPollers() {
  return Array.from(activePollers.values()).map((poller) => ({
    id: poller.config.id,
    namespace: poller.namespace,
    config: poller.config,
  }));
}

export async function updateModbusPollerMqtt(plcId, mqttConfig, namespace = "modbus") {
  const poller = activePollers.get(pollerKey(plcId, namespace));
  if (!poller) return false;
  await poller.updateMqtt(mqttConfig);
  return true;
}

export async function updateActiveModbusPollersMqtt(mqttConfig) {
  const pollers = Array.from(activePollers.values());
  await Promise.allSettled(pollers.map((poller) => poller.updateMqtt(mqttConfig)));
}

export async function stopAllModbusPollers() {
  const entries = Array.from(activePollers.values()).map((poller) => ({
    id: poller.config.id,
    namespace: poller.namespace,
  }));
  await Promise.allSettled(
    entries.map(({ id, namespace }) => stopModbusPoller(id, namespace)),
  );
}

function setPollingStatus(plcId, status, namespace = "modbus") {
  pollingStatuses.set(pollerKey(plcId, namespace), {
    plcId: String(plcId),
    updatedAt: Date.now(),
    ...status,
  });
}

export function getModbusPollerStatus(plcId, namespace = "modbus") {
  return (
    pollingStatuses.get(pollerKey(plcId, namespace)) ?? {
      plcId: String(plcId),
      updatedAt: null,
      pollingStatus: "NOT_CONNECTED",
      registers: [],
      dataBlocks: [],
    }
  );
}

export async function stopModbusPoller(plcId, namespace = "modbus") {
  const key = pollerKey(plcId, namespace);
  const poller = activePollers.get(key);
  if (!poller) return;

  await poller.stop();
  if (activePollers.get(key) !== poller) return;
  activePollers.delete(key);
  setPollingStatus(plcId, {
    pollingStatus: "NOT_CONNECTED",
    registers: getModbusPollerStatus(plcId, namespace).registers,
    dataBlocks: getModbusPollerStatus(plcId, namespace).dataBlocks,
  }, namespace);
}

export async function testModbusPollerConnection(rawConfig) {
  const config = normalizeModbusConfig(rawConfig);
  const connection = acquireModbusConnection(config);
  try {
    return await connection.run(config, (client) => readModbusSample(client, config));
  } finally {
    await connection.release();
  }
}

export async function startModbusPoller(rawConfig, namespace = "modbus", options = {}) {
  // Validate before touching any running acquisition.
  let config = normalizeModbusConfig(rawConfig);
  const { keepAliveOnInitialError = false, retryIntervalMs } = options;
  const key = pollerKey(config.id, namespace);
  const getStatus = () => getModbusPollerStatus(config.id, namespace);
  const setStatus = (status) => setPollingStatus(config.id, status, namespace);
  const existing = activePollers.get(key);
  if (existing && sameConnection(existing.config, config)) {
    return existing.update(config, options);
  }
  await stopModbusPoller(config.id, namespace);

  const connection = acquireModbusConnection(config);
  let timer;
  let stopped = false;
  let operationQueue = Promise.resolve();
  let stopPromise;
  let publishDatablocks = createModbusDatablockPublisher(publishPayload);
  const blockFreshness = new Map();

  const enrichBlockFreshness = (blocks, observedAt) => {
    const activeKeys = new Set();
    const enriched = blocks.map((block) => {
      const key = JSON.stringify([block.startAddress, block.topic]);
      activeKeys.add(key);
      const fingerprint = JSON.stringify(block.values ?? null);
      let entry = blockFreshness.get(key);
      if (!entry) {
        entry = {
          fingerprint,
          firstSeenAt: observedAt,
          lastDataUpdatedAt: null,
          updateCount: 0,
        };
        blockFreshness.set(key, entry);
      } else if (entry.fingerprint !== fingerprint) {
        entry.fingerprint = fingerprint;
        entry.lastDataUpdatedAt = observedAt;
        entry.updateCount += 1;
      }
      return {
        ...block,
        firstSeenAt: entry.firstSeenAt,
        lastDataUpdatedAt: entry.lastDataUpdatedAt,
        updateCount: entry.updateCount,
      };
    });
    for (const key of blockFreshness.keys()) {
      if (!activeKeys.has(key)) blockFreshness.delete(key);
    }
    return enriched;
  };

  const runExclusive = (operation) => {
    const result = operationQueue.then(() => {
      if (stopped) {
        throw new Error("Modbus polling has stopped; retry the connection test");
      }
      return operation();
    });
    // A failed test must not prevent subsequent polling or tests.
    operationQueue = result.catch(() => undefined);
    return result;
  };

  const readAndPublish = async () => {
    if (config.readMode === "Read by Datablocks") {
      const rawBlocks = await connection.run(config, (client) => readModbusDatablocks(client, config));
      const dataBlocks = enrichBlockFreshness(rawBlocks, Date.now());
      const published = await publishDatablocks(config, dataBlocks);
      const topics = dataBlocks.map((block) => block.topic);
      setStatus({
        pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
        mqttTopics: topics,
        registers: [],
        dataBlocks,
      });
      return { registers: [], dataBlocks, published, topics };
    }
    const registers = await connection.run(config, (client) => readModbusRegisters(client, config.registers));
    const timestamp = new Date().toISOString();
    const payload = {
      plcId: config.id,
      protocol: "modbus.tcp",
      unitId: config.unitId,
      timestamp,
      values: Object.fromEntries(
        registers.map((register) => [register.name, register.value]),
      ),
      registers,
    };
    const topic = config.mqttTopic || `festo/plc/${config.id}`;
    const published = await publishPayload(config.mqtt, topic, payload);
    setStatus({
      pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
      mqttTopic: topic,
      registers,
      dataBlocks: [],
    });
    return { registers, published, topic };
  };

  const schedulePoll = (startedAt, unhealthy = false) => {
    clearTimeout(timer);
    if (stopped) return;
    if (unhealthy) {
      const retryDelay = Number.isFinite(retryIntervalMs)
        ? Math.max(10, retryIntervalMs)
        : Math.min(Math.max(config.polling, OFFLINE_RETRY_MIN_MS), OFFLINE_RETRY_MAX_MS);
      timer = setTimeout(poll, retryDelay);
      return;
    }
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const delayMs = Math.max(10, config.polling - elapsed);
    timer = setTimeout(poll, delayMs);
  };

  const poll = async () => {
    if (stopped) return;
    const startedAt = Date.now();
    let failed = false;

    try {
      await runExclusive(async () => {
        try {
          await readAndPublish();
        } catch (error) {
          failed = true;
          const message = modbusErrorMessage(error);
          setStatus({
            pollingStatus: "UNHEALTHY",
            registers: getStatus().registers,
            dataBlocks: getStatus().dataBlocks,
            error: message,
          });
          recordDiagnosticEvent({
            level: "error",
            component: "modbus",
            plcId: config.id,
            message: `Modbus polling failed: ${message}`,
          });
          console.error(`Modbus PLC ${config.id} polling failed`, error);
        }
      });
    } catch (error) {
      failed = true;
      if (!stopped) console.error(`Modbus PLC ${config.id} polling failed`, error);
    } finally {
      schedulePoll(startedAt, failed);
    }
  };

  const poller = {
    get config() { return config; },
    get namespace() { return namespace; },
    update: (nextConfig, updateOptions = {}) => runExclusive(async () => {
      if (
        config.readMode !== nextConfig.readMode ||
        (config.layoutMode ?? "standard") !== (nextConfig.layoutMode ?? "standard") ||
        config.endian !== nextConfig.endian ||
        JSON.stringify(config.fields ?? null) !== JSON.stringify(nextConfig.fields ?? null)
      ) {
        publishDatablocks = createModbusDatablockPublisher(publishPayload);
        blockFreshness.clear();
      }
      config = nextConfig;
      let failed = false;
      try {
        // Saving changes the polling configuration, not the TCP connection.
        return { connected: true, ...await readAndPublish() };
      } catch (error) {
        failed = true;
        const message = modbusErrorMessage(error);
        // The saved configuration stays active even when its first read fails.
        setStatus({
          pollingStatus: "UNHEALTHY",
          registers: [],
          dataBlocks: [],
          error: message,
        });
        if (updateOptions.keepAliveOnInitialError) {
          return { connected: false, retrying: true, error: message };
        }
        throw error;
      } finally {
        schedulePoll(undefined, failed);
      }
    }),
    updateMqtt: (nextMqtt) => runExclusive(async () => {
      config = { ...config, mqtt: nextMqtt };
      if (["UNHEALTHY", "MQTT_NOT_CONFIGURED"].includes(getStatus().pollingStatus)) {
        clearTimeout(timer);
        if (!stopped) timer = setTimeout(poll, 50);
      }
    }),
    test: (testConfig) => runExclusive(async () => {
      return connection.run(testConfig, (client) => readModbusSample(client, testConfig));
    }),
    stop: () => {
      if (!stopPromise) {
        stopped = true;
        clearTimeout(timer);
        // Let an in-flight read finish before closing its socket.
        stopPromise = operationQueue.then(() => connection.release());
      }
      return stopPromise;
    },
  };
  // Register before the first read so a concurrent test also joins the queue.
  activePollers.set(key, poller);
  try {
    const result = await runExclusive(readAndPublish);
    schedulePoll();
    return { connected: true, ...result };
  } catch (error) {
    const message = modbusErrorMessage(error);
    if (keepAliveOnInitialError) {
      setStatus({
        pollingStatus: "UNHEALTHY",
        registers: [],
        dataBlocks: [],
        error: message,
      });
      schedulePoll(undefined, true);
      return { connected: false, retrying: true, error: message };
    }
    await poller.stop();
    if (activePollers.get(key) === poller) {
      activePollers.delete(key);
      setStatus({
        pollingStatus: "UNHEALTHY",
        registers: [],
        dataBlocks: [],
        error: message,
      });
    }
    throw error;
  }
}
