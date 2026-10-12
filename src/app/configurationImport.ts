import { deduplicateConnections, storeConnections } from "./storage";
import type { SavedConnection } from "./storage";

export type PreparedConfiguration = {
  connections: SavedConnection[];
  mqttConfig: Record<string, string>;
  configurationId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newId() {
  return crypto.randomUUID();
}

function parseUri(uri: string) {
  try {
    return new URL(uri);
  } catch {
    throw new Error(`Invalid connection URI: ${uri}`);
  }
}

function parseDataBlocks(configuration: Record<string, unknown>) {
  const rawDbs = String(configuration.dbs ?? "");
  const polling = String(configuration.defaultPollingRate ?? "500");
  const blocks = rawDbs
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => {
      const [dataBlock, size] = value.split(":");
      return { id: index, dataBlock, polling, ...(size ? { size } : {}) };
    });
  return blocks.length > 0 ? blocks : [{ id: 0, dataBlock: "", polling }];
}

function parseMessageSource(source: unknown, index: number): SavedConnection {
  if (
    !isRecord(source) ||
    typeof source.id !== "string" ||
    typeof source.uri !== "string"
  ) {
    throw new Error(`Message source ${index + 1} is incomplete`);
  }

  const uri = parseUri(source.uri);
  const protocol = uri.protocol.replace(":", "");
  const uniqueKey =
    typeof source.uniqueKey === "string" ? source.uniqueKey : newId();
  const status: SavedConnection["status"] =
    source.status === "connected" || source.status === "error"
      ? source.status
      : "disconnected";
  const connectionError =
    status !== "connected" && typeof source.connectionError === "string"
      ? source.connectionError
      : undefined;

  if (protocol === "s7") {
    const configuration = isRecord(source.s7PniConfiguration)
      ? source.s7PniConfiguration
      : {};
    const dataBlocks = parseDataBlocks(configuration);
    return {
      recordId: uniqueKey,
      id: source.id,
      protocol: "s7",
      host: uri.hostname,
      port: uri.port || "102",
      details: typeof source.details === "string"
        ? source.details
        : `remote-rack: ${uri.searchParams.get("remote-rack") ?? "0"}, remote-slot: ${uri.searchParams.get("remote-slot") ?? "1"}`,
      status,
      connectionError,
      config: {
        id: source.id,
        host: uri.hostname,
        port: uri.port || "102",
        rack: uri.searchParams.get("remote-rack") ?? "0",
        slot: uri.searchParams.get("remote-slot") ?? "1",
        dataBlocks,
        messageLayout: String(configuration.messageLayout ?? "mip"),
      },
    };
  }

  if (protocol === "ads") {
    const configuration = isRecord(source.beckhoffConfiguration)
      ? source.beckhoffConfiguration
      : {};
    const [targetNetId, targetPort] = String(configuration.fbs ?? ":").split(
      ":",
    );
    const polling = String(configuration.defaultPollingRate ?? "500");
    return {
      recordId: uniqueKey,
      id: source.id,
      protocol: "ads",
      host: uri.hostname,
      port: uri.port || "48898",
      details: typeof source.details === "string"
        ? source.details
        : `target-net-id: ${uri.searchParams.get("targetAmsNetId") ?? targetNetId}, target-port: ${uri.searchParams.get("targetAmsPort") ?? targetPort}`,
      status,
      connectionError,
      config: {
        id: source.id,
        host: uri.hostname,
        port: uri.port || "48898",
        targetNetId: uri.searchParams.get("targetAmsNetId") ?? targetNetId,
        targetPort: uri.searchParams.get("targetAmsPort") ?? targetPort,
        sourceNetId: uri.searchParams.get("sourceAmsNetId") ?? "",
        sourcePort: uri.searchParams.get("sourceAmsPort") ?? "",
        polling,
        mode: configuration.scanMode === "auto" ? "Automatic" : "Custom",
      },
    };
  }

  const configurationKey =
    protocol === "opc.tcp" || protocol === "modbus.tcp"
      ? "configuration"
      : `${protocol}Configuration`;
  return {
    recordId: uniqueKey,
    id: source.id,
    protocol,
    host: uri.hostname,
    port: uri.port || "",
    details: typeof source.details === "string" ? source.details : "",
    status,
    connectionError,
    config: isRecord(source[configurationKey])
      ? source[configurationKey]
      : isRecord(source.configuration)
        ? source.configuration
        : {},
  };
}

export function prepareConfiguration(value: unknown): PreparedConfiguration {
  if (!isRecord(value) || !Array.isArray(value.messageSources)) {
    throw new Error("The file must contain a messageSources array");
  }
  if (!isRecord(value.mqttMessageHandler)) {
    throw new Error("The file must contain mqttMessageHandler");
  }

  const connections = deduplicateConnections(
    value.messageSources.map(parseMessageSource),
  );
  const mqttHandler = value.mqttMessageHandler;
  if (typeof mqttHandler.uri !== "string") {
    throw new Error("The MQTT configuration must contain a uri");
  }
  const mqttUri = parseUri(mqttHandler.uri);
  const basicAuthentication = isRecord(mqttHandler.basicAuthentication)
    ? mqttHandler.basicAuthentication
    : {};
  const hasBasicAuthentication = Object.keys(basicAuthentication).length > 0;

  return {
    connections,
    mqttConfig: {
      protocol: mqttUri.protocol === "tcp:" ? "tcp://" : `${mqttUri.protocol}`,
      host: mqttUri.hostname,
      port: mqttUri.port || "1883",
      clientId: String(mqttHandler.clientId ?? ""),
      username: String(basicAuthentication.username ?? ""),
      password: String(basicAuthentication.password ?? ""),
      qos: String(mqttHandler.qos ?? "1"),
      authType: hasBasicAuthentication ? "Basic Authentication" : "None",
      status: "disconnected",
    },
    configurationId: typeof value.id === "string" ? value.id : undefined,
  };
}

export function storeConfiguration(configuration: PreparedConfiguration) {
  storeConnections(configuration.connections);
  localStorage.setItem(
    "festo-mqtt-config",
    JSON.stringify(configuration.mqttConfig),
  );
  if (configuration.configurationId) {
    localStorage.setItem(
      "festo-configuration-id",
      configuration.configurationId,
    );
  }
}
