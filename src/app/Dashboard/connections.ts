import {
  connectionKey,
  readMqttConfig,
  readSavedConnections,
  storeConnections,
} from "../storage";
import type { SavedConnection } from "../storage";
import { buildConfiguration } from "../configuration";
import { prepareConfiguration } from "../configurationImport";
import { MODBUS_DATABLOCK_DEFAULT_START_ADDRESS } from "../../../shared/modbusDatablock.js";

type MqttSummary = {
  clientId: string;
  protocol: string;
  host: string;
  port: string;
  status: "connected" | "disconnected";
};

type RescanResult = {
  connection: SavedConnection;
  status: SavedConnection["status"];
  connectionError?: string;
  supported: boolean;
};
const RESCAN_TIMEOUT_MS = 3000;

export function readMqttSummary(): MqttSummary | null {
  const saved = readMqttConfig();
  if (!saved || typeof saved.port !== "string") return null;
  const protocol = saved.protocol === "tcp:" ? "tcp://" : saved.protocol;
  return {
    clientId: typeof saved.clientId === "string" ? saved.clientId : "",
    protocol: typeof protocol === "string" ? protocol : "tcp://",
    host: saved.host as string,
    port: saved.port,
    status: saved.status === "connected" ? "connected" : "disconnected",
  };
}

export function prepareDatabaseConfiguration(configuration: unknown) {
  const prepared = prepareConfiguration(configuration);
  const previous = readMqttSummary();
  const previousConnections = readSavedConnections();
  const sameMqttConnection =
    previous &&
    previous.host === prepared.mqttConfig.host &&
    previous.port === prepared.mqttConfig.port;

  if (sameMqttConnection) {
    prepared.mqttConfig.status = previous.status;
  }

  prepared.connections = prepared.connections.map((connection) => {
    const previousConnection = previousConnections.find(
      (saved) =>
        saved.protocol === connection.protocol &&
        saved.id === connection.id &&
        saved.host === connection.host &&
        saved.port === connection.port &&
        JSON.stringify(saved.config) === JSON.stringify(connection.config),
    );

    return previousConnection
      ? {
          ...connection,
          status: previousConnection.status,
          connectionError: previousConnection.connectionError,
        }
      : connection;
  });

  return prepared;
}

export async function reconnect(connection: SavedConnection): Promise<RescanResult> {
  const config = connection.config ?? {};
  let endpoint: string;
  let body: Record<string, unknown>;

  if (connection.protocol === "s7") {
    const dataBlocks = Array.isArray(config.dataBlocks)
      ? config.dataBlocks.flatMap((block) => {
          if (typeof block !== "object" || block === null) return [];
          const value = block as Record<string, unknown>;
          const range = value.dataBlock ?? value.range;
          if (typeof range !== "string" || !range) return [];
          return [
            {
              range,
              polling: Number(value.polling ?? config.polling ?? 500),
              ...(value.size ? { size: Number(value.size) } : {}),
            },
          ];
        })
      : [];
    endpoint = "/api/plcs/siemens/connect";
    body = {
      id: connection.id,
      host: connection.host,
      port: Number(connection.port),
      rack: Number(config.rack ?? 0),
      slot: Number(config.slot ?? 1),
      polling: Number(dataBlocks[0]?.polling ?? config.polling ?? 500),
      dataBlocks,
      messageLayout: String(config.messageLayout ?? "mip"),
      mqtt: readMqttConfig(),
      mqttTopic: `festo-ax/pni/${connection.id}`,
    };
  } else if (connection.protocol === "opc.tcp") {
    endpoint = "/api/plcs/opcua/connect";
    body = {
      id: connection.id,
      host: connection.host,
      port: Number(connection.port),
      server: String(config.server ?? ""),
      securityMode: String(config.securityMode ?? "NONE_MODE"),
      securityPolicy: String(config.securityPolicy ?? "NONE"),
      authType: String(config.authType ?? "None"),
      polling: Number(config.polling ?? 500),
      nodeIds: Array.isArray(config.nodeIds) ? config.nodeIds : [],
      mqtt: readMqttConfig(),
      mqttTopic: `festo/plc/${connection.id}`,
    };
  } else if (connection.protocol === "modbus.tcp") {
    const byDatablocks = config.readMode === "Read by Datablocks";
    endpoint = "/api/plcs/modbus/connect";
    body = {
      id: connection.id,
      host: connection.host,
      port: Number(connection.port),
      unitId: Number(config.unitId ?? 1),
      timeout: Number(config.timeout ?? 3000),
      polling: Number(config.polling ?? 500),
      readMode: byDatablocks ? "Read by Datablocks" : "Read by registers",
      ...(byDatablocks
        ? {
            startAddress:
              config.startAddress === undefined
                ? MODBUS_DATABLOCK_DEFAULT_START_ADDRESS
                : config.startAddress,
            registerCount: config.registerCount,
            blockTopics: Array.isArray(config.blockTopics)
              ? config.blockTopics
              : [],
          }
        : {
            registers: Array.isArray(config.registers) ? config.registers : [],
          }),
      mqtt: readMqttConfig(),
      mqttTopic: `festo/plc/${connection.id}`,
    };
  } else {
    return {
      connection,
      status: "disconnected",
      connectionError: "This PLC type is not supported yet",
      supported: false,
    };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), RESCAN_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const result = (await response.json()) as {
      connected?: boolean;
      error?: string;
    } | null;
    const connected = response.ok && result?.connected;
    return {
      connection,
      status: connected ? "connected" : "disconnected",
      connectionError: connected
        ? undefined
        : (result?.error || "Unable to connect to the PLC"),
      supported: true,
    };
  } catch {
    return {
      connection,
      status: "disconnected",
      connectionError: controller.signal.aborted
        ? "PLC connection attempt timed out"
        : "Unable to reach the PLC backend",
      supported: true,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

export function storeRescanResults(results: RescanResult[]) {
  const outcomes = new Map(
    results.map((result) => [connectionKey(result.connection), result]),
  );
  storeConnections(
    readSavedConnections().map((connection) => {
      const result = outcomes.get(connectionKey(connection));
      return result
        ? {
            ...connection,
            status: result.status,
            connectionError: result.connectionError,
          }
        : connection;
    }),
  );
}

export function downloadConfiguration(connections: SavedConnection[]) {
  const blob = new Blob(
    [JSON.stringify(buildConfiguration(connections), null, 4)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "configuration-pni-connector.json";
  link.click();
  URL.revokeObjectURL(url);
}
