import {
  connectSiemens,
  readSiemensData,
  readSiemensMipMessage,
} from "./siemensReader.js";
import { publishPayload } from "../mqttPublisher.js";

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

export function getSiemensPollerStatus(plcId) {
  return (
    pollingStatuses.get(String(plcId)) ?? {
      plcId: String(plcId),
      updatedAt: null,
      pollingStatus: "NOT_CONNECTED",
      dataBlocks: [],
    }
  );
}

export function stopSiemensPoller(plcId) {
  const poller = activePollers.get(plcId);
  if (!poller) return;

  poller.stop();
  activePollers.delete(plcId);
  setPollingStatus(plcId, {
    pollingStatus: "NOT_CONNECTED",
    dataBlocks: getSiemensPollerStatus(plcId).dataBlocks,
  });
}

export async function startSiemensPoller(config) {
  stopSiemensPoller(config.id);

  const client = await connectSiemens(config);
  let stopped = false;
  let reading = false;
  let timer;

  const publishCurrentData = async () => {
    if (config.messageLayout === "mip") {
      const message = await readSiemensMipMessage(client, config);
      const published = await publishPayload(
        config.mqtt,
        message.topic,
        message.payload,
      );
      setPollingStatus(config.id, {
        pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
        dataBlocks: [
          {
            dataBlock: message.dataBlock,
            ...message.identifiers,
          },
        ],
      });
      return;
    }

    const payload = await readSiemensData(client, config);
    await publishPayload(config.mqtt, config.mqttTopic, payload);
  };

  const poll = async () => {
    if (stopped || reading) return;

    reading = true;
    try {
      await publishCurrentData();
    } catch (error) {
      setPollingStatus(config.id, {
        pollingStatus: "UNHEALTHY",
        dataBlocks: getSiemensPollerStatus(config.id).dataBlocks,
        error: errorMessage(error),
      });
      console.error(`PLC ${config.id} polling failed`, error);
    } finally {
      reading = false;
      if (!stopped) {
        timer = setTimeout(poll, Math.max(100, Number(config.polling ?? 500)));
      }
    }
  };

  try {
    await publishCurrentData();
  } catch (error) {
    setPollingStatus(config.id, {
      pollingStatus: "UNHEALTHY",
      dataBlocks: [],
      error: errorMessage(error),
    });
    client.Disconnect();
    throw error;
  }

  activePollers.set(config.id, {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      client.Disconnect();
    },
  });
  timer = setTimeout(poll, Math.max(100, Number(config.polling ?? 500)));

  return { connected: true };
}
