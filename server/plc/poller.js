import { connectSiemens, readSiemensData } from "./siemensReader.js";
import { publishPayload } from "../mqttPublisher.js";

const activePollers = new Map();

export function stopSiemensPoller(plcId) {
  const poller = activePollers.get(plcId);
  if (!poller) return;

  poller.stop();
  activePollers.delete(plcId);
}

export async function startSiemensPoller(config) {
  stopSiemensPoller(config.id);

  const client = await connectSiemens(config);
  let stopped = false;
  let reading = false;
  let timer;

  const poll = async () => {
    if (stopped || reading) return;

    reading = true;
    try {
      const payload = await readSiemensData(client, config);
      await publishPayload(config.mqtt, config.mqttTopic, payload);
    } catch (error) {
      console.error(`PLC ${config.id} polling failed`, error);
    } finally {
      reading = false;
      if (!stopped) {
        timer = setTimeout(poll, Math.max(100, Number(config.polling ?? 500)));
      }
    }
  };

  await poll();
  activePollers.set(config.id, {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      client.Disconnect();
    },
  });

  return { connected: true };
}
