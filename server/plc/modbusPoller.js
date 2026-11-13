import { acquireModbusConnection } from "./modbusConnectionPool.js";
import { publishPayload } from "../mqttPublisher.js";
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

function sameConnection(first, second) {
  return first.host.toLowerCase() === second.host.toLowerCase() && first.port === second.port;
}

function pollerKey(plcId, namespace) { return JSON.stringify([namespace, String(plcId)]); }

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

export async function startModbusPoller(rawConfig, namespace = "modbus") {
  // Validate before touching any running acquisition.
  let config = normalizeModbusConfig(rawConfig);
  const key = pollerKey(config.id, namespace);
  const getStatus = () => getModbusPollerStatus(config.id, namespace);
  const setStatus = (status) => setPollingStatus(config.id, status, namespace);
  const existing = activePollers.get(key);
  if (existing && sameConnection(existing.config, config)) {
    return existing.update(config);
  }
  await stopModbusPoller(config.id, namespace);

  const connection = acquireModbusConnection(config);
  let timer;
  let stopped = false;
  let operationQueue = Promise.resolve();
  let stopPromise;
  let publishDatablocks = createModbusDatablockPublisher(publishPayload);

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
      const dataBlocks = await connection.run(config, (client) => readModbusDatablocks(client, config));
      let published = true;
      if (config.layoutMode === "custom") {
        for (const block of dataBlocks) {
          const delivered = await publishPayload(config.mqtt, block.topic, block.values);
          published = delivered && published;
        }
      } else {
        published = await publishDatablocks(config, dataBlocks);
      }
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

  const schedulePoll = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(poll, config.polling);
  };

  const poll = async () => {
    if (stopped) return;

    try {
      await runExclusive(async () => {
        try {
          await readAndPublish();
        } catch (error) {
          setStatus({
            pollingStatus: "UNHEALTHY",
            registers: getStatus().registers,
            dataBlocks: getStatus().dataBlocks,
            error: modbusErrorMessage(error),
          });
          console.error(`Modbus PLC ${config.id} polling failed`, error);
        }
      });
    } catch (error) {
      if (!stopped) console.error(`Modbus PLC ${config.id} polling failed`, error);
    } finally {
      schedulePoll();
    }
  };

  const poller = {
    get config() { return config; },
    update: (nextConfig) => runExclusive(async () => {
      if (
        config.readMode !== nextConfig.readMode ||
        (config.layoutMode ?? "standard") !== (nextConfig.layoutMode ?? "standard") ||
        config.endian !== nextConfig.endian
      ) {
        publishDatablocks = createModbusDatablockPublisher(publishPayload);
      }
      config = nextConfig;
      try {
        // Saving changes the polling configuration, not the TCP connection.
        return { connected: true, ...await readAndPublish() };
      } catch (error) {
        // The saved configuration stays active even when its first read fails.
        setStatus({
          pollingStatus: "UNHEALTHY",
          registers: [],
          dataBlocks: [],
          error: modbusErrorMessage(error),
        });
        throw error;
      } finally {
        schedulePoll();
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
    await poller.stop();
    if (activePollers.get(key) === poller) {
      activePollers.delete(key);
      setStatus({
        pollingStatus: "UNHEALTHY",
        registers: [],
        dataBlocks: [],
        error: modbusErrorMessage(error),
      });
    }
    throw error;
  }
}
