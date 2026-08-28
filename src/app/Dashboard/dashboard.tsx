import { Fragment, useEffect, useState } from "react";
import {
  IconAdd,
  IconCheckStatus,
  IconDelete,
  IconEdit,
  IconExport,
  IconFailure,
  IconMore,
  IconMenu,
  IconReinitialize,
  IconRefresh,
  IconUpdate,
} from "@festo-ui/react-icons";
import dashboardIcon from "../../assets/dashboards-icon.png";
import { useNavigate } from "react-router-dom";
import type { SavedConnection } from "../Add/storage";
import ImportPage from "../Import";

type Page = "Status" | "Import" | "Downloads";
type Asset = "MIP" | "ENI" | "MIE";
type MqttSummary = {
  protocol: string;
  host: string;
  port: string;
  status: "connected" | "disconnected";
};
const editPaths: Record<string, string> = {
  s7: "/add/siemens",
  eip: "/add/rockwell",
  ads: "/add/beckhoff",
  "opc.tcp": "/add/opcua",
};
const downloadsUrl =
  "https://www.festo.com/de/en/p/ax-motion-insights-pneumatic-id_GASA_MIP/?tab=SUPPORT_PORTAL&documentTypeGroup=EXPERT_KNOWLEDGE&supportPortalTab=18";

const defaultConnection: SavedConnection = {
  id: "PLC id",
  protocol: "s7",
  host: "hostname",
  port: "port",
  details: "remote-rack: 0, remote-slot: 1",
  status: "disconnected",
};

function readMqttSummary(): MqttSummary | null {
  try {
    const saved = JSON.parse(
      localStorage.getItem("festo-mqtt-config") ?? "null",
    ) as Partial<MqttSummary> | null;
    if (!saved || typeof saved.host !== "string" || typeof saved.port !== "string") {
      return null;
    }
    return {
      protocol: typeof saved.protocol === "string" ? saved.protocol : "tcp://",
      host: saved.host,
      port: saved.port,
      status: saved.status === "connected" ? "connected" : "disconnected",
    };
  } catch {
    return null;
  }
}

function readConnections() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("festo-connections") ?? "[]",
    ) as SavedConnection[];
    const defaultRows =
      localStorage.getItem("festo-default-connection-hidden") === "true"
        ? []
        : [defaultConnection];
    return [...defaultRows, ...(Array.isArray(saved) ? saved : [])];
  } catch {
    return [defaultConnection];
  }
}

function readJsonStorage(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
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
  const protocol = connection.protocol === "opc.tcp" ? "opc.tcp://" : `${connection.protocol}://`;
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
    const dataBlocks = Array.isArray(config.dataBlocks) ? config.dataBlocks : [];
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

function buildExportConfiguration(connections: SavedConnection[]) {
  const mqtt = readJsonStorage("festo-mqtt-config") ?? {};
  const messageSources = connections.filter((connection) => connection !== defaultConnection).map((connection) => ({
    id: connection.id,
    uri: getConnectionUri(connection),
    uniqueKey: connection.recordId ?? `${connection.protocol}-${connection.id}`,
    ...getMessageSourceConfiguration(connection),
  }));
  const mqttUri = `${String(mqtt.protocol ?? "tcp://")}${String(mqtt.host ?? "")}:${String(mqtt.port ?? "1883")}`;
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

function downloadConfiguration(connections: SavedConnection[]) {
  const blob = new Blob(
    [JSON.stringify(buildExportConfiguration(connections), null, 4)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "configuration-pni-connector.json";
  link.click();
  URL.revokeObjectURL(url);
}

function Action({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className="fwe-action" type="button" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function ConnectionStatus({ status }: { status: SavedConnection["status"] }) {
  if (status === "connected") {
    return (
      <span className="fwe-status fwe-status-connected">
        <IconCheckStatus aria-hidden="true" />
        Connected
      </span>
    );
  }

  return (
    <span className="fwe-status">
      <IconFailure aria-hidden="true" />
      Disconnected
    </span>
  );
}

export default function Dashboard() {
  const [page, setPage] = useState<Page>("Status");
  const [asset, setAsset] = useState<Asset>("MIP");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    index: number;
    connection: SavedConnection;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const [mqttSummary, setMqttSummary] = useState<MqttSummary | null>(
    readMqttSummary,
  );
  const [connections, setConnections] =
    useState<SavedConnection[]>(readConnections);
  const navigate = useNavigate();
  useEffect(() => {
    const refreshConnections = () => {
      setConnections(readConnections());
    };
    window.addEventListener("storage", refreshConnections);
    const refreshMqtt = () => setMqttSummary(readMqttSummary());
    window.addEventListener("storage", refreshMqtt);
    return () => {
      window.removeEventListener("storage", refreshConnections);
      window.removeEventListener("storage", refreshMqtt);
    };
  }, []);
  const notify = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2200);
  };
  const deleteConnection = (index: number, connection: SavedConnection) => {
    try {
      if (connection === defaultConnection) {
        localStorage.setItem("festo-default-connection-hidden", "true");
        setConnections(readConnections());
        setExpandedIndex(null);
        notify("Connection deleted");
        return;
      }
      const saved = JSON.parse(
        localStorage.getItem("festo-connections") ?? "[]",
      ) as SavedConnection[];
      const defaultVisible = connections[0] === defaultConnection;
      saved.splice(index - (defaultVisible ? 1 : 0), 1);
      localStorage.setItem("festo-connections", JSON.stringify(saved));
      setConnections(readConnections());
      setExpandedIndex(null);
      notify("Connection deleted");
    } catch {
      notify("Unable to delete connection");
    }
  };

  return (
    <div className="fwe-app">
      <header className="fwe-fixed-header">
        <nav className="fwe-navbar">
          <div className="fwe-navbar-inner">
            <nav className="fwe-navlist" aria-label="Main navigation">
              <div className="fwe-assets-menu">
                <button
                  className="fwe-dashboard-link"
                  type="button"
                  aria-label="Go to Dashboard"
                  onClick={() => navigate("/dashboard")}
                >
                  <img src={dashboardIcon} alt="Dashboard" />
                </button>
                <button
                  className="fwe-assets-trigger"
                  type="button"
                  aria-expanded={assetsOpen}
                  aria-label="Open asset menu"
                  onClick={() => setAssetsOpen(!assetsOpen)}
                >
                  <IconMenu aria-hidden="true" />
                </button>
                {assetsOpen && (
                  <div className="fwe-assets-dropdown" role="menu">
                    <div className="fwe-assets-dropdown-title">
                      Select asset
                    </div>
                    {(["MIP", "ENI", "MIE"] as Asset[]).map((item) => (
                      <button
                        key={item}
                        type="button"
                        role="menuitem"
                        className={asset === item ? "is-selected" : ""}
                        onClick={() => {
                          setAsset(item);
                          setAssetsOpen(false);
                        }}
                      >
                        <span>{item}</span>
                        {asset === item && (
                          <span className="fwe-selected-mark">✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {(["Status", "Import", "Downloads"] as Page[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={page === item ? "fwe-active" : ""}
                  onClick={() => {
                    if (item === "Downloads") {
                      window.location.assign(downloadsUrl);
                      return;
                    }
                    setPage(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </nav>
            <div className="fwe-logo-container">
              <div className="fwe-festo-logo" aria-label="Festo" />
            </div>
          </div>
        </nav>
      </header>
      <div className="fwe-navbar-spacer" />
      <main className="fwe-main-content">
        {page === "Import" ? (
          <ImportPage
            onImported={() => {
              setConnections(readConnections());
              setMqttSummary(readMqttSummary());
              setPage("Status");
              notify("Configuration imported");
            }}
            onCancel={() => setPage("Status")}
          />
        ) : asset === "MIP" && page === "Status" ? (
          <div className="fwe-layout">
            <section className="fwe-status-list">
              <div className="fwe-section-heading">
                <h1>PLC Connections</h1>
                <div className="fwe-actions">
                  <Action
                    icon={<IconReinitialize aria-hidden="true" />}
                    label="Rescan"
                    onClick={() => notify("Rescanning connections")}
                  />
                  <Action
                    icon={<IconRefresh aria-hidden="true" />}
                    label="Refresh"
                    onClick={() => notify("Connections refreshed")}
                  />
                  <Action
                    icon={<IconExport aria-hidden="true" />}
                    label="Export"
                    onClick={() => {
                      downloadConfiguration(connections);
                      notify("Configuration exported");
                    }}
                  />
                  <Action
                    icon={<IconAdd aria-hidden="true" />}
                    label="Add PLC"
                    onClick={() => navigate("/add")}
                  />
                </div>
              </div>
              <div className="fwe-table-scroll">
                <table className="fwe-table">
                  <thead>
                    <tr>
                      <th className="fwe-icon-cell" />
                      <th>Id</th>
                      <th>Protocol</th>
                      <th>Host</th>
                      <th>Port</th>
                      <th>Connection details</th>
                      <th>Status</th>
                      <th className="fwe-menu-cell" />
                    </tr>
                  </thead>
                  <tbody>
                    {connections.map((connection, index) => (
                      <Fragment
                        key={`${connection.protocol}-${connection.id}-${index}`}
                      >
                        <tr
                          className={
                            expandedIndex === index ? "fwe-expanded" : ""
                          }
                          key={`${connection.protocol}-${connection.id}-${index}`}
                        >
                          <td className="fwe-icon-cell">
                            <button
                              className={`fwe-expand ${expandedIndex === index ? "is-expanded" : ""}`}
                              type="button"
                              aria-label="Toggle connection details"
                              onClick={() =>
                                setExpandedIndex(
                                  expandedIndex === index ? null : index,
                                )
                              }
                            >
                              ›
                            </button>
                          </td>
                          <td>{connection.id}</td>
                          <td>{connection.protocol}</td>
                          <td>{connection.host}</td>
                          <td>{connection.port}</td>
                          <td className="fwe-connection-details">
                            <span className="fwe-connection-details-content">
                              {connection.details}
                            </span>
                          </td>
                          <td>
                            <ConnectionStatus status={connection.status} />
                          </td>
                          <td className="fwe-menu-cell">
                            <button
                              className="fwe-icon-button"
                              type="button"
                              aria-label="PLC connection actions"
                              onClick={() =>
                                setOpenMenuIndex(
                                  openMenuIndex === index ? null : index,
                                )
                              }
                            >
                              <IconMore />
                            </button>
                            {openMenuIndex === index && (
                              <div className="fwe-row-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="fwe-menu-edit"
                                  onClick={() => {
                                    const path = editPaths[connection.protocol];
                                    if (path) {
                                      navigate(path, {
                                        state: { connection },
                                      });
                                    } else {
                                      notify("This PLC type cannot be edited");
                                    }
                                    setOpenMenuIndex(null);
                                  }}
                                >
                                  <IconEdit aria-hidden="true" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="fwe-menu-delete"
                                  onClick={() => {
                                    setDeleteTarget({ index, connection });
                                    setOpenMenuIndex(null);
                                  }}
                                >
                                  <IconDelete aria-hidden="true" />
                                  Delete
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => {
                                    notify(`Rescanning PLC ${connection.id}`);
                                    setOpenMenuIndex(null);
                                  }}
                                >
                                  <IconUpdate aria-hidden="true" />
                                  Rescan
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                        {expandedIndex === index && (
                          <tr
                            className="fwe-details-row"
                            key={`${connection.protocol}-${connection.id}-${index}-details`}
                          >
                            <td colSpan={8}>
                              <div className="fwe-details">
                                <p className="fwe-details-message">
                                  {connection.details}
                                </p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="fwe-section-heading fwe-mqtt-heading">
                <h2>MQTT Connection</h2>
              </div>
              <div className="fwe-table-scroll">
                <table className="fwe-table fwe-mqtt-table">
                  <thead>
                    <tr>
                      <th className="fwe-icon-cell" />
                      <th>Id</th>
                      <th>URI</th>
                      <th>Status</th>
                      <th className="fwe-menu-cell" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="fwe-icon-cell" />
                      <td>12</td>
                      <td>
                        {mqttSummary
                          ? `${mqttSummary.protocol}${mqttSummary.host}:${mqttSummary.port}`
                          : "tcp://192.168.0.1:12"}
                      </td>
                      <td>
                        <ConnectionStatus status={mqttSummary?.status ?? "disconnected"} />
                      </td>
                      <td className="fwe-menu-cell">
                        <button
                          className="fwe-edit-link"
                          type="button"
                          aria-label="Edit MQTT connection"
                          onClick={() => navigate("/mqtt")}
                        >
                          <IconEdit aria-hidden="true" />
                          Edit
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : (
          <section className="fwe-placeholder">
            <h1>{asset}</h1>
            <p>
              {asset === "MIP"
                ? `The ${page.toLowerCase()} view is ready.`
                : `${asset} dashboard is ready to be connected.`}
            </p>
          </section>
        )}
      </main>
      <footer className="fwe-footer">
        <div>
          <button
            type="button"
            onClick={() => notify("Festo AX Connector v24.0.6")}
          >
            Version 24.0.6
          </button>
          <button type="button">Privacy Policy</button>
          <button type="button">Imprint</button>
        </div>
      </footer>
      {notice && (
        <div className="fwe-snackbar" role="status">
          {notice}
        </div>
      )}
      {deleteTarget && (
        <div
          className="fwe-modal-backdrop"
          role="presentation"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="fwe-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-plc-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="fwe-modal-close"
              type="button"
              aria-label="Close"
              onClick={() => setDeleteTarget(null)}
            ></button>
            <div className="fwe-modal-header">
              <h2>PLC Connections</h2>
              <h1 id="delete-plc-title">Delete PLC?</h1>
            </div>
            <div className="fwe-modal-body">
              Do you want to delete &quot;{deleteTarget.connection.id}&quot;
              permanently?
            </div>
            <div className="fwe-modal-footer">
              <button
                className="fwe-modal-cancel"
                type="button"
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                className="fwe-modal-confirm"
                type="button"
                onClick={() => {
                  deleteConnection(deleteTarget.index, deleteTarget.connection);
                  setDeleteTarget(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
