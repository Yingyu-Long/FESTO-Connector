import type { SavedConnection } from "./Add/storage";

function readJsonStorage(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as Record<
      string,
      unknown
    > | null;
  } catch {
    return null;
  }
}

function getConfigurationId() {
  const stored = localStorage.getItem("festo-configuration-id");
  if (stored) return stored;

  const id = crypto.randomUUID();
  localStorage.setItem("festo-configuration-id", id);
  return id;
}

function getConnectionUri(connection: SavedConnection) {
  const config = connection.config ?? {};
  const protocol =
    connection.protocol === "opc.tcp"
      ? "opc.tcp://"
      : `${connection.protocol}://`;
  const baseUri = `${protocol}${connection.host}:${connection.port}`;

  if (connection.protocol === "s7") {
    const params = new URLSearchParams({
      "remote-rack": String(config.rack ?? "0"),
      "remote-slot": String(config.slot ?? "1"),
    });
    return `${baseUri}?${params}`;
  }

  if (connection.protocol === "ads") {
    const params = new URLSearchParams({
      targetAmsPort: String(config.targetPort ?? "851"),
      sourceAmsPort: String(config.sourcePort ?? "32905"),
      targetAmsNetId: String(config.targetNetId ?? ""),
      sourceAmsNetId: String(config.sourceNetId ?? ""),
    });
    return `${baseUri}?${params}`;
  }

  return baseUri;
}

function getMessageSourceConfiguration(connection: SavedConnection) {
  const config = connection.config ?? {};

  if (connection.protocol === "s7") {
    const dataBlocks = Array.isArray(config.dataBlocks)
      ? config.dataBlocks
      : [];
    const dbs = dataBlocks
      .map((item) => {
        if (typeof item !== "object" || item === null) return "";
        const block = item as Record<string, unknown>;
        const range = String(block.dataBlock ?? block.range ?? "");
        const size = block.size;
        return range && size ? `${range}:${size}` : range;
      })
      .filter(Boolean)
      .join(",");
    const firstBlock = dataBlocks[0];
    const polling =
      typeof firstBlock === "object" && firstBlock !== null
        ? (firstBlock as Record<string, unknown>).polling
        : undefined;

    return {
      s7PniConfiguration: {
        dbs,
        defaultPollingRate: String(polling ?? config.polling ?? "500"),
        messageLayout: String(config.messageLayout ?? "mip"),
      },
    };
  }

  if (connection.protocol === "ads") {
    const automatic = config.mode === "Automatic";
    return {
      beckhoffConfiguration: {
        fbs: `${String(config.targetNetId ?? "")}:${String(config.targetPort ?? "")}`,
        defaultPollingRate: String(config.polling ?? "500"),
        scanMode: automatic ? "auto" : "custom",
        scanAllOthers: automatic,
        defaultPollingRateForAllOthers: String(config.polling ?? "500"),
      },
    };
  }

  return { configuration: config };
}

export function buildConfiguration(connections: SavedConnection[]) {
  const mqtt = readJsonStorage("festo-mqtt-config") ?? {};
  const messageSources = connections.map((connection) => ({
    id: connection.id,
    uri: getConnectionUri(connection),
    uniqueKey: connection.recordId ?? `${connection.protocol}-${connection.id}`,
    ...getMessageSourceConfiguration(connection),
  }));
  const mqttProtocol =
    mqtt.protocol === "tcp:" ? "tcp://" : String(mqtt.protocol ?? "tcp://");
  const mqttUri = `${mqttProtocol}${String(mqtt.host ?? "")}:${String(mqtt.port ?? "1883")}`;
  const mqttAuthentication =
    mqtt.authType === "Basic Authentication"
      ? {
          basicAuthentication: {
            username: String(mqtt.username ?? ""),
            password: String(mqtt.password ?? ""),
          },
        }
      : { anonymousAuthentication: {} };

  return {
    messageSources,
    mqttMessageHandler: {
      clientId: String(mqtt.clientId ?? ""),
      uri: mqttUri,
      qos: Number(mqtt.qos ?? 1),
      ...mqttAuthentication,
    },
    id: getConfigurationId(),
  };
}
