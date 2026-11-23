import {
  AttributeIds,
  ClientMonitoredItem,
  ClientSubscription,
  DataType,
  TimestampsToReturn,
} from "node-opcua";
import { publishPayload } from "../mqttPublisher.js";
import { recordDiagnosticEvent } from "../debugBot/diagnosticLog.js";
import { isValidMqttPublishTopic } from "../../shared/mqttTopic.js";
import { connectOpcua, disconnectOpcua } from "./opcuaClient.js";

const activePollers = new Map();
const pollingStatuses = new Map();

export function getOpcuaPollerStatus(plcId) {
  return (
    pollingStatuses.get(String(plcId)) ?? {
      plcId: String(plcId),
      updatedAt: null,
      pollingStatus: "NOT_CONNECTED",
      dataBlocks: [],
    }
  );
}

export function listActiveOpcuaPollers() {
  return Array.from(activePollers.entries()).map(([id, entry]) => ({
    id: String(id),
    status: getOpcuaPollerStatus(id),
    dataBlockCount: entry.dataBlockCount ?? 0,
  }));
}

function serializableValue(value) {
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializableValue);
  return value;
}

export function normalizeOpcuaDataBlocks(config) {
  const legacyNodes = Array.isArray(config.selectedNodes)
    ? config.selectedNodes
    : [];
  const legacyNodeIds =
    Array.isArray(config.nodeIds) && config.nodeIds.length > 0
      ? config.nodeIds
      : legacyNodes.flatMap((node) =>
          node && typeof node === "object" && typeof node.nodeId === "string"
            ? [node.nodeId]
            : [],
        );
  const legacyNames = new Map(
    legacyNodes.flatMap((node) =>
      node && typeof node === "object" && typeof node.nodeId === "string"
        ? [
            [
              node.nodeId,
              typeof node.displayName === "string"
                ? node.displayName
                : node.nodeId,
            ],
          ]
        : [],
    ),
  );
  const rawBlocks =
    Array.isArray(config.dataBlocks) && config.dataBlocks.length > 0
      ? config.dataBlocks
      : [
          {
            name: "Datablock 1",
            mqttTopic: config.mqttTopic,
            nodeIds: legacyNodeIds,
            nodes: legacyNodeIds.map((nodeId) => ({
              nodeId,
              displayName: legacyNames.get(nodeId) ?? nodeId,
            })),
          },
        ];
  const seenNodeIds = new Set();
  const seenTopics = new Set();

  const blocks = rawBlocks.map((raw, index) => {
    const block = raw && typeof raw === "object" ? raw : {};
    const configuredNodes =
      Array.isArray(block.nodes) && block.nodes.length > 0
        ? block.nodes
        : Array.isArray(block.selectedNodes) && block.selectedNodes.length > 0
          ? block.selectedNodes
          : Array.isArray(block.nodeIds)
            ? block.nodeIds.map((nodeId) => ({ nodeId }))
            : [];
    const rawNodes = configuredNodes;
    const nodes = rawNodes.flatMap((node) => {
      if (typeof node === "string")
        return node ? [{ nodeId: node, displayName: node }] : [];
      if (
        !node ||
        typeof node !== "object" ||
        typeof node.nodeId !== "string" ||
        !node.nodeId
      )
        return [];
      return [
        {
          nodeId: node.nodeId,
          displayName:
            typeof node.displayName === "string" && node.displayName.trim()
              ? node.displayName
              : node.nodeId,
        },
      ];
    });
    const name =
      typeof block.name === "string" && block.name.trim()
        ? block.name.trim()
        : `Datablock ${index + 1}`;
    const baseTopic = `festo/plc/${String(config.id ?? "{PLC ID}").trim() || "{PLC ID}"}`;
    const fallbackTopic =
      index === 0 &&
      typeof config.mqttTopic === "string" &&
      config.mqttTopic.trim()
        ? config.mqttTopic.trim()
        : index === 0
          ? baseTopic
          : `${baseTopic}/datablock-${index + 1}`;
    const mqttTopic =
      typeof block.mqttTopic === "string" && block.mqttTopic.trim()
        ? block.mqttTopic.trim()
        : fallbackTopic;

    if (nodes.length === 0)
      throw new Error(`${name} must contain at least one variable`);
    if (!isValidMqttPublishTopic(mqttTopic))
      throw new Error(`${name} has an invalid MQTT topic`);
    if (seenTopics.has(mqttTopic))
      throw new Error("Each Datablock must use a unique MQTT topic");
    seenTopics.add(mqttTopic);
    for (const node of nodes) {
      if (seenNodeIds.has(node.nodeId))
        throw new Error(
          `OPC UA variable ${node.nodeId} is assigned more than once`,
        );
      seenNodeIds.add(node.nodeId);
    }
    return { name, mqttTopic, nodes };
  });

  if (blocks.length === 0)
    throw new Error("At least one OPC UA Datablock is required");
  return blocks;
}

export async function stopOpcuaPoller(plcId) {
  const poller = activePollers.get(plcId);
  if (!poller) return;

  activePollers.delete(plcId);
  await poller.stop();
  pollingStatuses.set(String(plcId), {
    plcId: String(plcId),
    updatedAt: Date.now(),
    pollingStatus: "NOT_CONNECTED",
    dataBlocks: getOpcuaPollerStatus(plcId).dataBlocks,
  });
}

export async function startOpcuaPoller(config) {
  await stopOpcuaPoller(config.id);

  const dataBlocks = normalizeOpcuaDataBlocks(config);
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

    for (const block of dataBlocks) {
      const latestValues = new Map();
      for (const node of block.nodes) {
        const monitoredItem = ClientMonitoredItem.create(
          subscription,
          { nodeId: node.nodeId, attributeId: AttributeIds.Value },
          {
            samplingInterval: Math.max(100, Number(config.polling ?? 500)),
            discardOldest: true,
            queueSize: 10,
          },
          TimestampsToReturn.Both,
        );

        monitoredItem.on("changed", (dataValue) => {
          const variant = dataValue.value;
          latestValues.set(node.nodeId, {
            nodeId: node.nodeId,
            name: node.displayName,
            value: serializableValue(variant?.value ?? null),
            dataType: variant ? DataType[variant.dataType] : "Null",
            timestamp: (
              dataValue.sourceTimestamp ??
              dataValue.serverTimestamp ??
              new Date()
            ).toISOString(),
            statusCode: dataValue.statusCode.toString(),
          });

          if (latestValues.size < block.nodes.length) return;
          const payload = {
            plcId: config.id,
            dataBlock: block.name,
            values: block.nodes.map((member) =>
              latestValues.get(member.nodeId),
            ),
          };
          void publishPayload(config.mqtt, block.mqttTopic, payload)
            .then((published) => {
              pollingStatuses.set(String(config.id), {
                plcId: String(config.id),
                updatedAt: Date.now(),
                pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
                dataBlocks: dataBlocks.map((b) => ({
                  name: b.name,
                  mqttTopic: b.mqttTopic,
                  nodeCount: b.nodes.length,
                })),
              });
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              pollingStatuses.set(String(config.id), {
                plcId: String(config.id),
                updatedAt: Date.now(),
                pollingStatus: "UNHEALTHY",
                dataBlocks: getOpcuaPollerStatus(config.id).dataBlocks,
                error: message,
              });
              recordDiagnosticEvent({
                level: "error",
                component: "opcua",
                plcId: config.id,
                message: `OPC UA MQTT publish failed for ${block.name}: ${message}`,
              });
              console.error(
                `OPC UA ${config.id} MQTT publish failed for ${block.name}`,
                error,
              );
            });
        });

        monitoredItem.on("err", (error) => {
          const message = error instanceof Error ? error.message : String(error);
          recordDiagnosticEvent({
            level: "error",
            component: "opcua",
            plcId: config.id,
            message: `OPC UA monitor ${node.nodeId} failed: ${message}`,
          });
          console.error(
            `OPC UA ${config.id} monitor ${node.nodeId} failed`,
            error,
          );
        });
      }
    }

    pollingStatuses.set(String(config.id), {
      plcId: String(config.id),
      updatedAt: Date.now(),
      pollingStatus: config.mqtt?.host ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
      dataBlocks: dataBlocks.map((b) => ({
        name: b.name,
        mqttTopic: b.mqttTopic,
        nodeCount: b.nodes.length,
      })),
    });

    activePollers.set(config.id, {
      dataBlockCount: dataBlocks.length,
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
