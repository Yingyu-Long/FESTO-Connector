import { publishPayload } from "../mqttPublisher.js";
import {
  connectModbus,
  disconnectModbus,
  normalizeModbusConfig,
  readModbusRegisters,
} from "./modbusClient.js";

const activePollers = new Map();
const pollingStatuses = new Map();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
    }
  );
}

export async function stopModbusPoller(plcId) {
  const key = String(plcId);
  const poller = activePollers.get(key);
  if (!poller) return;

  activePollers.delete(key);
  await poller.stop();
  setPollingStatus(key, {
    pollingStatus: "NOT_CONNECTED",
    registers: getModbusPollerStatus(key).registers,
  });
}

export async function startModbusPoller(rawConfig) {
  const config = normalizeModbusConfig(rawConfig);
  await stopModbusPoller(config.id);

  let client;
  let timer;
  let stopped = false;
  let reading = false;

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
    });
    return { registers, published, topic };
  };

  const poll = async () => {
    if (stopped || reading) return;

    reading = true;
    try {
      await readAndPublish();
    } catch (error) {
      await closeClient();
      setPollingStatus(config.id, {
        pollingStatus: "UNHEALTHY",
        registers: getModbusPollerStatus(config.id).registers,
        error: errorMessage(error),
      });
      console.error(`Modbus PLC ${config.id} polling failed`, error);
    } finally {
      reading = false;
      if (!stopped) timer = setTimeout(poll, config.polling);
    }
  };

  try {
    const result = await readAndPublish();
    activePollers.set(String(config.id), {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        await closeClient();
      },
    });
    timer = setTimeout(poll, config.polling);
    return { connected: true, ...result };
  } catch (error) {
    await closeClient();
    setPollingStatus(config.id, {
      pollingStatus: "UNHEALTHY",
      registers: [],
      error: errorMessage(error),
    });
    throw error;
  }
}
