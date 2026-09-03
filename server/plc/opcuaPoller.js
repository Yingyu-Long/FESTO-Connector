import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSubscription,
  DataType,
  TimestampsToReturn,
} from "node-opcua";
import { publishPayload } from "../mqttPublisher.js";
import { connectOpcua, disconnectOpcua } from "./opcuaClient.js";

const activePollers = new Map();

function serializableValue(value) {
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializableValue);
  return value;
}

export async function stopOpcuaPoller(plcId) {
  const poller = activePollers.get(plcId);
  if (!poller) return;

  activePollers.delete(plcId);
  await poller.stop();
}

export async function startOpcuaPoller(config) {
  await stopOpcuaPoller(config.id);

  const connection = await connectOpcua(config);
  let subscription;
  let stopped = false;

  try {
    subscription = ClientSubscription.create(connection.session, {
      requestedPublishingInterval: Math.max(100, Number(config.polling ?? 500)),
      requestedLifetimeCount: 6000,
      requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 0,
      publishingEnabled: true,
      priority: 1,
    });

    await new Promise((resolve, reject) => {
      subscription.once("started", resolve);
      subscription.once("internal_error", reject);
    });

    for (const nodeId of config.nodeIds) {
      const monitoredItem = ClientMonitoredItem.create(
        subscription,
        { nodeId, attributeId: AttributeIds.Value },
        {
          samplingInterval: Math.max(100, Number(config.polling ?? 500)),
          discardOldest: true,
          queueSize: 10,
        },
        TimestampsToReturn.Both,
      );

      monitoredItem.on("changed", (dataValue) => {
        const variant = dataValue.value;
        const payload = {
          plcId: config.id,
          nodeId,
          value: serializableValue(variant?.value ?? null),
          dataType: variant ? DataType[variant.dataType] : "Null",
          timestamp: (
            dataValue.sourceTimestamp ?? dataValue.serverTimestamp ?? new Date()
          ).toISOString(),
          statusCode: dataValue.statusCode.toString(),
        };

        void publishPayload(config.mqtt, config.mqttTopic, payload).catch((error) => {
          console.error(`OPC UA ${config.id} MQTT publish failed`, error);
        });
      });

      monitoredItem.on("err", (error) => {
        console.error(`OPC UA ${config.id} monitor ${nodeId} failed`, error);
      });
    }

    activePollers.set(config.id, {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await subscription.terminate();
        await disconnectOpcua(connection);
      },
    });
  } catch (error) {
    if (subscription) await subscription.terminate();
    await disconnectOpcua(connection);
    throw error;
  }
}
