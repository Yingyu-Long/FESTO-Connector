import { Fragment, useEffect, useState } from "react";
import { LoadingIndicator } from "@festo-ui/react";
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
import { deduplicateConnections } from "../Add/storage";
import type { SavedConnection } from "../Add/storage";
import ImportPage from "../Import";
import { buildConfiguration } from "../configuration";
import {
  deleteConfigurationSource,
  loadConfiguration,
} from "../configurationApi";
import { prepareConfiguration } from "../configurationImport";

type Page = "Status" | "Import" | "Downloads";
type Asset = "MIP" | "ENI" | "MIE";
type MqttSummary = {
  protocol: string;
  host: string;
  port: string;
  status: "connected" | "disconnected";
};

type DetailItem = {
  label: string;
  value: string;
};

type RescanResult = {
  connection: SavedConnection;
  status: SavedConnection["status"];
  supported: boolean;
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
    if (
      !saved ||
      typeof saved.host !== "string" ||
      typeof saved.port !== "string"
    ) {
      return null;
    }
    const protocol = saved.protocol === "tcp:" ? "tcp://" : saved.protocol;
    return {
      protocol: typeof protocol === "string" ? protocol : "tcp://",
      host: saved.host,
      port: saved.port,
      status: saved.status === "connected" ? "connected" : "disconnected",
    };
  } catch {
    return null;
  }
}

function prepareDatabaseConfiguration(configuration: unknown) {
  const prepared = prepareConfiguration(configuration);
  const previous = readMqttSummary();
  const previousConnections = readConnections();
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
        saved.port === connection.port,
    );

    return previousConnection?.status === "connected"
      ? { ...connection, status: "connected" }
      : connection;
  });

  return prepared;
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
    return [
      ...defaultRows,
      ...(Array.isArray(saved) ? deduplicateConnections(saved) : []),
    ];
  } catch {
    return [defaultConnection];
  }
}

function connectionKey(connection: SavedConnection) {
  return connection.recordId ?? `${connection.protocol}-${connection.id}`;
}

function readMqttConfig() {
  try {
    const config = JSON.parse(
      localStorage.getItem("festo-mqtt-config") ?? "null",
    ) as Record<string, unknown> | null;
    return config && typeof config.host === "string" && config.host
      ? config
      : undefined;
  } catch {
    return undefined;
  }
}

async function reconnect(connection: SavedConnection): Promise<RescanResult> {
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
      mqtt: readMqttConfig(),
      mqttTopic: `festo/plc/${connection.id}`,
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
  } else {
    return { connection, status: "disconnected", supported: false };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => null)) as {
      connected?: boolean;
    } | null;
    return {
      connection,
      status: response.ok && result?.connected ? "connected" : "disconnected",
      supported: true,
    };
  } catch {
    return { connection, status: "disconnected", supported: true };
  }
}

function storeRescanResults(results: RescanResult[]) {
  const statuses = new Map(
    results.map((result) => [connectionKey(result.connection), result.status]),
  );
  try {
    const saved = JSON.parse(
      localStorage.getItem("festo-connections") ?? "[]",
    ) as SavedConnection[];
    if (!Array.isArray(saved)) return;
    localStorage.setItem(
      "festo-connections",
      JSON.stringify(
        saved.map((connection) => ({
          ...connection,
          status: statuses.get(connectionKey(connection)) ?? connection.status,
        })),
      ),
    );
  } catch {
    // Keep the current dashboard state when the local configuration is invalid.
  }
}

function downloadConfiguration(connections: SavedConnection[]) {
  const blob = new Blob(
    [
      JSON.stringify(
        buildConfiguration(
          connections.filter((connection) => connection !== defaultConnection),
        ),
        null,
        4,
      ),
    ],
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
  loading = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      className="fwe-action"
      type="button"
      onClick={onClick}
      disabled={loading}
    >
      {loading ? (
        <LoadingIndicator size="small">{label}...</LoadingIndicator>
      ) : (
        <>
          {icon}
          {label}
        </>
      )}
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

function connectionDetailItems(connection: SavedConnection): DetailItem[] {
  const config = connection.config ?? {};

  if (connection.protocol === "opc.tcp") {
    const selectedNodes = Array.isArray(config.selectedNodes)
      ? config.selectedNodes
      : [];
    const namedNodes = selectedNodes.flatMap((node) => {
      if (typeof node !== "object" || node === null) return [];
      const value = node as Record<string, unknown>;
      if (typeof value.nodeId !== "string") return [];
      return [
        {
          label:
            typeof value.displayName === "string"
              ? value.displayName
              : value.nodeId,
          value: value.nodeId,
        },
      ];
    });
    if (namedNodes.length > 0) return namedNodes;

    return Array.isArray(config.nodeIds)
      ? config.nodeIds
          .filter((nodeId): nodeId is string => typeof nodeId === "string")
          .map((nodeId) => ({ label: nodeId, value: nodeId }))
      : [];
  }

  if (connection.protocol === "s7" && Array.isArray(config.dataBlocks)) {
    return config.dataBlocks.flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const value = block as Record<string, unknown>;
      const dataBlock = value.dataBlock ?? value.range;
      if (typeof dataBlock !== "string" || !dataBlock) return [];
      const polling = value.polling;
      const size = value.size;
      const metadata = [
        typeof polling === "string" || typeof polling === "number"
          ? `${polling} ms`
          : "",
        typeof size === "string" || typeof size === "number"
          ? `size: ${size}`
          : "",
      ]
        .filter(Boolean)
        .join(" | ");
      return [{ label: dataBlock, value: metadata }];
    });
  }

  return [];
}

function ConnectionDetails({ connection }: { connection: SavedConnection }) {
  const items = connectionDetailItems(connection);
  const heading =
    connection.protocol === "opc.tcp"
      ? "Selected OPC UA nodes"
      : "S7 data blocks";

  return (
    <div className="fwe-details">
      <p className="fwe-details-message">{connection.details}</p>
      {items.length > 0 && (
        <section className="fwe-detail-items" aria-label={heading}>
          <h3>{heading}</h3>
          <ul>
            {items.map((item) => (
              <li key={`${item.label}-${item.value}`}>
                <strong>{item.label}</strong>
                {item.value && <span>{item.value}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [page, setPage] = useState<Page>("Status");
  const [asset, setAsset] = useState<Asset>("MIP");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);
  const [mqttMenuOpen, setMqttMenuOpen] = useState(false);
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
  const [rescanningKeys, setRescanningKeys] = useState<string[]>([]);
  const navigate = useNavigate();
  useEffect(() => {
    const refreshConnections = () => {
      setConnections(readConnections());
    };
    window.addEventListener("storage", refreshConnections);
    const refreshMqtt = () => setMqttSummary(readMqttSummary());
    window.addEventListener("storage", refreshMqtt);
    void loadConfiguration()
      .then((configuration) => {
        if (!configuration || !Array.isArray(configuration.messageSources))
          return;
        const prepared = prepareDatabaseConfiguration(configuration);
        const uniqueConnections = deduplicateConnections(prepared.connections);
        localStorage.setItem(
          "festo-connections",
          JSON.stringify(uniqueConnections),
        );
        localStorage.setItem(
          "festo-mqtt-config",
          JSON.stringify(prepared.mqttConfig),
        );
        localStorage.setItem("festo-default-connection-hidden", "true");
        if (typeof configuration.id === "string") {
          localStorage.setItem("festo-configuration-id", configuration.id);
        }
        setConnections(readConnections());
        setMqttSummary(readMqttSummary());
      })
      .catch((error) =>
        console.error("Unable to load database configuration", error),
      );
    return () => {
      window.removeEventListener("storage", refreshConnections);
      window.removeEventListener("storage", refreshMqtt);
    };
  }, []);
  const notify = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2200);
  };
  const rescanConnections = async (targets: SavedConnection[]) => {
    const reconnectable = targets.filter(
      (connection) => connection !== defaultConnection,
    );
    if (reconnectable.length === 0) return;

    const keys = reconnectable.map(connectionKey);
    setRescanningKeys((current) => [...new Set([...current, ...keys])]);
    const results = await Promise.all(reconnectable.map(reconnect));
    storeRescanResults(results);
    setConnections(readConnections());
    setRescanningKeys((current) =>
      current.filter((key) => !keys.includes(key)),
    );

    const connected = results.filter(
      (result) => result.status === "connected",
    ).length;
    const unsupported = results.filter((result) => !result.supported).length;
    notify(
      unsupported > 0
        ? `${connected} connected; ${unsupported} PLC type is not supported yet`
        : `${connected} of ${results.length} PLC connections succeeded`,
    );
  };
  const deleteConnection = async (
    index: number,
    connection: SavedConnection,
  ) => {
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
      const uniqueKey =
        connection.recordId ?? `${connection.protocol}-${connection.id}`;
      await deleteConfigurationSource(uniqueKey);
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
                    icon={<IconRefresh aria-hidden="true" />}
                    label="Refresh"
                    onClick={async () => {
                      try {
                        const configuration = await loadConfiguration();
                        if (configuration) {
                          const prepared =
                            prepareDatabaseConfiguration(configuration);
                          localStorage.setItem(
                            "festo-connections",
                            JSON.stringify(
                              deduplicateConnections(prepared.connections),
                            ),
                          );
                          localStorage.setItem(
                            "festo-mqtt-config",
                            JSON.stringify(prepared.mqttConfig),
                          );
                          if (typeof configuration.id === "string") {
                            localStorage.setItem(
                              "festo-configuration-id",
                              configuration.id,
                            );
                          }
                        } else {
                          localStorage.setItem("festo-connections", "[]");
                          localStorage.removeItem("festo-mqtt-config");
                        }
                        setConnections(readConnections());
                        setMqttSummary(readMqttSummary());
                        notify("Configuration refreshed");
                      } catch (error) {
                        notify(
                          error instanceof Error
                            ? error.message
                            : "Unable to refresh configuration",
                        );
                      }
                    }}
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
                    icon={<IconReinitialize aria-hidden="true" />}
                    label="Rescan"
                    loading={rescanningKeys.length > 0}
                    onClick={() => void rescanConnections(connections)}
                  />
                  <Action
                    icon={<IconAdd aria-hidden="true" />}
                    label="Add PLC"
                    onClick={() => navigate("/add")}
                  />
                </div>
              </div>
              <div className="fwe-table-scroll">
                <table className="fwe-table fwe-plc-table">
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
                                  disabled={rescanningKeys.includes(
                                    connectionKey(connection),
                                  )}
                                  onClick={() => {
                                    void rescanConnections([connection]);
                                    setOpenMenuIndex(null);
                                  }}
                                >
                                  {rescanningKeys.includes(
                                    connectionKey(connection),
                                  ) ? (
                                    <LoadingIndicator size="small">
                                      Rescanning...
                                    </LoadingIndicator>
                                  ) : (
                                    <>
                                      <IconUpdate aria-hidden="true" />
                                      Rescan
                                    </>
                                  )}
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
                              <ConnectionDetails connection={connection} />
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
                        <ConnectionStatus
                          status={mqttSummary?.status ?? "disconnected"}
                        />
                      </td>
                      <td className="fwe-menu-cell">
                        <button
                          className="fwe-icon-button"
                          type="button"
                          aria-label="MQTT connection actions"
                          aria-expanded={mqttMenuOpen}
                          onClick={() => setMqttMenuOpen((isOpen) => !isOpen)}
                        >
                          <IconMore />
                        </button>
                        {mqttMenuOpen && (
                          <div className="fwe-row-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="fwe-menu-edit"
                              onClick={() => {
                                setMqttMenuOpen(false);
                                navigate("/mqtt");
                              }}
                            >
                              <IconEdit aria-hidden="true" />
                              Edit
                            </button>
                          </div>
                        )}
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
