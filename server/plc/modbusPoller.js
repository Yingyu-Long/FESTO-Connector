import { publishPayload } from "../mqttPublisher.js";
import {
  connectModbus,
  disconnectModbus,
  modbusErrorMessage,
  normalizeModbusConfig,
  readModbusDatablocks,
  readModbusRegisters,
  readModbusSample,
  testModbusConnection,
} from "./modbusClient.js";

const activePollers = new Map();
const pollingStatuses = new Map();

function sameConnection(first, second) {
  return ["host", "port", "unitId", "timeout"].every(
    (key) => first[key] === second[key],
  );
}

function setPollingStatus(plcId, status) {
  pollingStatuses.set(String(plcId), {
    plcId: String(plcId),
    updatedAt: Date.now(),
    ...status,
  });
}

export function getModbusPollerStatus(plcId) {
  return (
    pollingStatuses.get(String(plcId)) ?? {
      plcId: String(plcId),
      updatedAt: null,
      pollingStatus: "NOT_CONNECTED",
      registers: [],
      dataBlocks: [],
    }
  );
}

export async function stopModbusPoller(plcId) {
  const key = String(plcId);
  const poller = activePollers.get(key);
  if (!poller) return;

  await poller.stop();
  if (activePollers.get(key) !== poller) return;
  activePollers.delete(key);
  setPollingStatus(key, {
    pollingStatus: "NOT_CONNECTED",
    registers: getModbusPollerStatus(key).registers,
    dataBlocks: getModbusPollerStatus(key).dataBlocks,
  });
}

export async function testModbusPollerConnection(rawConfig) {
  const config = normalizeModbusConfig(rawConfig);
  const poller = [...activePollers.values()].find((candidate) =>
    sameConnection(candidate.config, config),
  );

  // A PLC may accept only one TCP client. Test with a fresh read on the
  // existing connection, using the edited register configuration.
  return poller ? poller.test(config) : testModbusConnection(config);
}

export async function startModbusPoller(rawConfig) {
  let config;
  try {
    config = normalizeModbusConfig(rawConfig);
  } catch (error) {
    if (rawConfig?.id) {
      await stopModbusPoller(rawConfig.id);
      setPollingStatus(rawConfig.id, {
        pollingStatus: "UNHEALTHY",
        registers: [],
        dataBlocks: [],
        error: modbusErrorMessage(error),
      });
    }
    throw error;
  }
  const existing = activePollers.get(config.id);
  if (existing && sameConnection(existing.config, config)) {
    return existing.update(config);
  }
  await stopModbusPoller(config.id);

  let client;
  let timer;
  let stopped = false;
  let operationQueue = Promise.resolve();
  let stopPromise;

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

  const closeClient = async () => {
    const currentClient = client;
    client = undefined;
    await disconnectModbus(currentClient);
  };

  const connectIfNeeded = async () => {
    if (client?.isOpen) return;
    const connection = await connectModbus(config);
    client = connection.client;
  };

  const readAndPublish = async () => {
    await connectIfNeeded();
    if (config.readMode === "Read by Datablocks") {
      const dataBlocks = await readModbusDatablocks(client, config);
      let published = true;
      for (const block of dataBlocks) {
        const blockPublished = await publishPayload(
          config.mqtt,
          block.topic,
          block.values,
        );
        published = published && blockPublished;
      }
      const topics = dataBlocks.map((block) => block.topic);
      setPollingStatus(config.id, {
        pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
        mqttTopics: topics,
        registers: [],
        dataBlocks,
      });
      return { registers: [], dataBlocks, published, topics };
    }
    const registers = await readModbusRegisters(client, config.registers);
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
    setPollingStatus(config.id, {
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
          await closeClient();
          setPollingStatus(config.id, {
            pollingStatus: "UNHEALTHY",
            registers: getModbusPollerStatus(config.id).registers,
            dataBlocks: getModbusPollerStatus(config.id).dataBlocks,
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
      config = nextConfig;
      try {
        // Saving changes the polling configuration, not the TCP connection.
        return { connected: true, ...await readAndPublish() };
      } catch (error) {
        // The saved configuration stays active even when its first read fails.
        await closeClient();
        setPollingStatus(config.id, {
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
      await connectIfNeeded();
      return readModbusSample(client, testConfig);
    }),
    stop: () => {
      if (!stopPromise) {
        stopped = true;
        clearTimeout(timer);
        // Let an in-flight read finish before closing its socket.
        stopPromise = operationQueue.then(closeClient);
      }
      return stopPromise;
    },
  };
  // Register before the first read so a concurrent test also joins the queue.
  activePollers.set(config.id, poller);
  try {
    const result = await runExclusive(readAndPublish);
    schedulePoll();
    return { connected: true, ...result };
  } catch (error) {
    await poller.stop();
    if (activePollers.get(config.id) === poller) {
      activePollers.delete(config.id);
      setPollingStatus(config.id, {
        pollingStatus: "UNHEALTHY",
        registers: [],
        dataBlocks: [],
        error: modbusErrorMessage(error),
      });
    }
    throw error;
  }
}
