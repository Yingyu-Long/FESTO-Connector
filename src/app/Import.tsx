import { useRef, useState } from "react";
import { IconFailure, IconImport } from "@festo-ui/react-icons";
import type { SavedConnection } from "./Add/storage";

type ImportPageProps = {
  onImported: () => void;
  onCancel: () => void;
};

type PreparedConfiguration = {
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
      return {
        id: index,
        dataBlock,
        polling,
        ...(size ? { size } : {}),
      };
    });

  return blocks.length > 0
    ? blocks
    : [{ id: 0, dataBlock: "", polling }];
}

function parseMessageSource(source: unknown, index: number): SavedConnection {
  if (!isRecord(source) || typeof source.id !== "string" || typeof source.uri !== "string") {
    throw new Error(`Message source ${index + 1} is incomplete`);
  }

  const uri = parseUri(source.uri);
  const protocol = uri.protocol.replace(":", "");
  const uniqueKey = typeof source.uniqueKey === "string" ? source.uniqueKey : newId();

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
      details: `remote-rack: ${uri.searchParams.get("remote-rack") ?? "0"}, remote-slot: ${uri.searchParams.get("remote-slot") ?? "1"}`,
      status: "disconnected",
      editPath: "/add/siemens",
      config: {
        id: source.id,
        host: uri.hostname,
        port: uri.port || "102",
        rack: uri.searchParams.get("remote-rack") ?? "0",
        slot: uri.searchParams.get("remote-slot") ?? "1",
        dataBlocks,
      },
    };
  }

  if (protocol === "ads") {
    const configuration = isRecord(source.beckhoffConfiguration)
      ? source.beckhoffConfiguration
      : {};
    const [targetNetId, targetPort] = String(configuration.fbs ?? ":").split(":");
    const polling = String(configuration.defaultPollingRate ?? "500");
    return {
      recordId: uniqueKey,
      id: source.id,
      protocol: "ads",
      host: uri.hostname,
      port: uri.port || "48898",
      details: `target-net-id: ${uri.searchParams.get("targetAmsNetId") ?? targetNetId}, target-port: ${uri.searchParams.get("targetAmsPort") ?? targetPort}`,
      status: "disconnected",
      editPath: "/add/beckhoff",
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

  const configurationKey = protocol === "opc.tcp" ? "configuration" : `${protocol}Configuration`;
  return {
    recordId: uniqueKey,
    id: source.id,
    protocol,
    host: uri.hostname,
    port: uri.port || "",
    details: `uri: ${source.uri}`,
    status: "disconnected",
    config: isRecord(source[configurationKey]) ? source[configurationKey] : {},
  };
}

function prepareConfiguration(value: unknown): PreparedConfiguration {
  if (!isRecord(value) || !Array.isArray(value.messageSources)) {
    throw new Error("The file must contain a messageSources array");
  }
  if (!isRecord(value.mqttMessageHandler)) {
    throw new Error("The file must contain mqttMessageHandler");
  }

  const connections = value.messageSources.map(parseMessageSource);
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
      protocol: `${mqttUri.protocol}`,
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

function storeConfiguration(configuration: PreparedConfiguration) {
  localStorage.setItem(
    "festo-connections",
    JSON.stringify(configuration.connections),
  );
  localStorage.setItem(
    "festo-mqtt-config",
    JSON.stringify(configuration.mqttConfig),
  );
  if (configuration.configurationId) {
    localStorage.setItem("festo-configuration-id", configuration.configurationId);
  }
}

export default function Import({ onImported, onCancel }: ImportPageProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [pendingConfiguration, setPendingConfiguration] =
    useState<PreparedConfiguration | null>(null);

  const readFile = async (file: File) => {
    setFileName(file.name);
    setError("");
    try {
      if (!file.name.toLowerCase().endsWith(".json")) {
        throw new Error("Only .json files are supported");
      }
      setPendingConfiguration(prepareConfiguration(JSON.parse(await file.text())));
    } catch (reason) {
      setPendingConfiguration(null);
      setError(reason instanceof Error ? reason.message : "Unable to import configuration");
    }
  };

  const confirmImport = () => {
    if (!pendingConfiguration) return;
    storeConfiguration(pendingConfiguration);
    onImported();
  };

  return (
    <section className="fwe-import-page">
      <h1>Import configuration</h1>
      <div className="fwe-import-container">
        <div className="fwe-import-main">
          <button
            type="button"
            className={`fwe-import-dropzone ${dragging ? "is-dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) void readFile(file);
            }}
          >
            <IconImport className="fwe-import-icon" aria-hidden="true" />
            <strong>Drag &amp; drop file here</strong>
            <span>or</span>
            <span className="fwe-import-browse">Browse</span>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readFile(file);
              }}
            />
          </button>
          <p className="fwe-import-hint">Supported file format: *.json</p>
          {fileName && !error && pendingConfiguration && (
            <p className="fwe-import-selected">Selected: {fileName}</p>
          )}
          {error && (
            <div className="fwe-import-error" role="alert">
              <IconFailure aria-hidden="true" />
              {error}
            </div>
          )}
        </div>
        <aside className="fwe-import-info">
          <strong>Import a JSON configuration file</strong>
          <p>
            The file must contain the connector configuration, including
            message sources and the MQTT message handler.
          </p>
          <p>Imported PLC connections will replace the current PLC list.</p>
        </aside>
      </div>
      <div className="fwe-import-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="fwe-import-confirm"
          disabled={!pendingConfiguration}
          onClick={confirmImport}
        >
          Import
        </button>
      </div>
    </section>
  );
}
