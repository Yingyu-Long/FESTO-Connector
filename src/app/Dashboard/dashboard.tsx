import { Fragment, useEffect, useState } from "react";
import { LoadingIndicator } from "@festo-ui/react";
import {
  IconAdd, IconCheckStatus, IconDelete, IconEdit, IconExport,
  IconFailure, IconMore, IconReinitialize, IconRefresh, IconUpdate,
} from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { AppFooter, AppHeader } from "../AppLayout";
import { useAppShell } from "../appShellContext";
import { connectionKey, readSavedConnections, storeConnections } from "../storage";
import type { SavedConnection } from "../storage";
import ImportPage from "../Import";
import { deleteConfigurationSource, loadConfiguration } from "../configurationApi";
import { storeConfiguration } from "../configurationImport";
import {
  downloadConfiguration, prepareDatabaseConfiguration,
  readMqttSummary, reconnect, storeRescanResults,
} from "./connections";
import ConnectionDetails from "./ConnectionDetails";
import type { S7PollingStatus } from "./ConnectionDetails";
import {
  connectionDisplayError, connectionDisplayStatus,
  loadModbusConnectionStatus, modbusStatusKey, isModbusConnection, modbusEndpoint,
} from "./modbusStatus";
import type { ModbusConnectionStatus } from "./modbusStatus";

const editPaths: Record<string, string> = {
  s7: "/add/siemens",
  eip: "/add/rockwell",
  ads: "/add/beckhoff",
  "opc.tcp": "/add/opcua",
  "modbus.tcp": "/add/modbus",
  "modbus.customised.tcp": "/add/modbus",
};
function Action({
  icon,
  label,
  onClick,
  loading = false,
  primary = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  loading?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      className={`fwe-action${primary ? " is-primary" : ""}`}
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

function ConnectionStatus({
  status,
  error,
  zh,
}: {
  status: SavedConnection["status"] | "checking" | "unavailable";
  error?: string;
  zh: boolean;
}) {
  if (status === "checking") {
    return <span className="fwe-status">{zh ? "检查中..." : "Checking..."}</span>;
  }
  if (status === "connected") {
    return (
      <span className="fwe-status fwe-status-connected">
        <IconCheckStatus aria-hidden="true" />
        {zh ? "已连接" : "Connected"}
      </span>
    );
  }

  return (
    <span className="fwe-status" title={error}>
      <IconFailure aria-hidden="true" />
      {status === "unavailable"
        ? zh
          ? "状态不可用"
          : "Status unavailable"
        : zh
          ? "未连接"
          : "Disconnected"}
    </span>
  );
}

export default function Dashboard() {
  const { language } = useAppShell();
  const zh = language === "zh";
  const { pathname } = useLocation();
  const page = pathname === "/import" ? "Import" : "Status";
  const [asset, setAsset] = useState<"MIP" | "ENI" | "MIE">("MIP");
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);
  const [mqttMenuOpen, setMqttMenuOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedConnection | null>(null);
  const [notice, setNotice] = useState("");
  const [mqttSummary, setMqttSummary] = useState(readMqttSummary);
  const [connections, setConnections] =
    useState<SavedConnection[]>(readSavedConnections);
  const [rescanningKeys, setRescanningKeys] = useState<string[]>([]);
  const [s7Statuses, setS7Statuses] = useState<Record<string, S7PollingStatus>>(
    {},
  );
  const [modbusStatuses, setModbusStatuses] = useState<
    Record<string, ModbusConnectionStatus>
  >({});
  const navigate = useNavigate();

  const expandedConnection =
    expandedIndex === null ? null : (connections[expandedIndex] ?? null);

  useEffect(() => {
    const targets = connections.filter(
      isModbusConnection,
    );
    if (targets.length === 0) return;

    let cancelled = false;
    let timer: number | undefined;
    let requestTimeout: number | undefined;
    let controller: AbortController;
    const refreshStatus = async () => {
      controller = new AbortController();
      requestTimeout = window.setTimeout(() => controller.abort(), 5000);
      const entries = await Promise.all(
        targets.map(
          async (connection) =>
            [
              modbusStatusKey(connection),
              await loadModbusConnectionStatus(connection, controller.signal),
            ] as const,
        ),
      );
      window.clearTimeout(requestTimeout);
      if (cancelled) return;
      setModbusStatuses(Object.fromEntries(entries));
      timer = window.setTimeout(() => void refreshStatus(), 1000);
    };
    void refreshStatus();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(requestTimeout);
    };
  }, [connections]);

  useEffect(() => {
    if (!expandedConnection || expandedConnection.protocol !== "s7") return;

    let cancelled = false;
    const loadStatus = async () => {
      try {
        const response = await fetch(
          `/api/plcs/siemens/${encodeURIComponent(expandedConnection.id)}/status`,
        );
        if (!response.ok || cancelled) return;
        const status = (await response.json()) as S7PollingStatus;
        if (!cancelled) {
          setS7Statuses((current) => ({
            ...current,
            [expandedConnection.id]: status,
          }));
        }
      } catch {
        // The connection row already reports the last known PLC status.
      }
    };

    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [expandedConnection]);
  useEffect(() => {
    const refreshConnections = () => {
      setConnections(readSavedConnections());
    };
    window.addEventListener("storage", refreshConnections);
    const refreshMqtt = () => setMqttSummary(readMqttSummary());
    window.addEventListener("storage", refreshMqtt);
    void loadConfiguration()
      .then((configuration) => {
        if (!configuration || !Array.isArray(configuration.messageSources))
          return;
        const prepared = prepareDatabaseConfiguration(configuration);
        storeConfiguration(prepared);
        setConnections(readSavedConnections());
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
      (connection) => !rescanningKeys.includes(connectionKey(connection)),
    );
    if (reconnectable.length === 0) return;

    const keys = reconnectable.map(connectionKey);
    setRescanningKeys((current) => [...new Set([...current, ...keys])]);
    try {
      const results = await Promise.all(reconnectable.map(reconnect));
      storeRescanResults(results);
      setConnections(readSavedConnections());

      const connected = results.filter(
        (result) => result.status === "connected",
      ).length;
      const unsupported = results.filter((result) => !result.supported).length;
      const messages = [`${connected} of ${results.length} PLC connections succeeded`];
      if (unsupported > 0) messages.push(`${unsupported} PLC type(s) not supported yet`);
      notify(messages.join("; "));
    } catch {
      notify("Unable to rescan PLC connections");
    } finally {
      setRescanningKeys((current) =>
        current.filter((key) => !keys.includes(key)),
      );
    }
  };
  const deleteConnection = async (connection: SavedConnection) => {
    try {
      if (isModbusConnection(connection)) {
        const stopResponse = await fetch(
          `${modbusEndpoint(connection)}/${encodeURIComponent(connection.id)}`,
          { method: "DELETE" },
        );
        if (!stopResponse.ok) {
          throw new Error("Unable to stop Modbus polling");
        }
      }
      const key = connectionKey(connection);
      await deleteConfigurationSource(key);
      storeConnections(readSavedConnections().filter((item) => connectionKey(item) !== key));
      setConnections(readSavedConnections());
      setExpandedIndex(null);
      notify("Connection deleted");
    } catch {
      notify("Unable to delete connection");
    }
  };

  return (
    <div className="fwe-app">
      <AppHeader asset={asset} onAssetChange={setAsset} />
      <main className="fwe-main-content">
        {page === "Import" ? (
          <ImportPage
            onImported={() => {
              setConnections(readSavedConnections());
              setMqttSummary(readMqttSummary());
              navigate("/dashboard");
              notify("Configuration imported");
            }}
            onCancel={() => navigate("/dashboard")}
          />
        ) : asset === "MIP" ? (
          <div className="fwe-layout">
            <section className="fwe-status-list">
              <div className="fwe-section-heading">
                <h1>{zh ? "PLC 连接列表" : "PLC Connections"}</h1>
                <div className="fwe-actions">
                  <Action
                    icon={<IconRefresh aria-hidden="true" />}
                    label={zh ? "刷新" : "Refresh"}
                    onClick={async () => {
                      try {
                        const configuration = await loadConfiguration();
                        if (configuration) {
                          const prepared =
                            prepareDatabaseConfiguration(configuration);
                          storeConfiguration(prepared);
                        } else {
                          storeConnections([]);
                          localStorage.removeItem("festo-mqtt-config");
                        }
                        setConnections(readSavedConnections());
                        setMqttSummary(readMqttSummary());
                        notify(zh ? "配置已刷新" : "Configuration refreshed");
                      } catch (error) {
                        notify(
                          error instanceof Error
                            ? error.message
                            : zh
                              ? "无法刷新配置"
                              : "Unable to refresh configuration",
                        );
                      }
                    }}
                  />
                  <Action
                    icon={<IconExport aria-hidden="true" />}
                    label={zh ? "导出" : "Export"}
                    onClick={() => {
                      downloadConfiguration(connections);
                      notify(zh ? "配置已导出" : "Configuration exported");
                    }}
                  />
                  <Action
                    icon={<IconReinitialize aria-hidden="true" />}
                    label={zh ? "重连扫描" : "Rescan"}
                    loading={rescanningKeys.length > 0}
                    onClick={() => void rescanConnections(connections)}
                  />
                  <Action
                    icon={<IconAdd aria-hidden="true" />}
                    label={zh ? "添加 PLC" : "Add PLC"}
                    primary
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
                      <th>{zh ? "协议" : "Protocol"}</th>
                      <th>{zh ? "主机" : "Host"}</th>
                      <th>{zh ? "端口" : "Port"}</th>
                      <th>{zh ? "连接详情" : "Connection details"}</th>
                      <th>{zh ? "状态" : "Status"}</th>
                      <th className="fwe-menu-cell" />
                    </tr>
                  </thead>
                  <tbody>
                    {connections.length === 0 && (
                      <tr>
                        <td colSpan={8}>
                          {zh ? "尚未配置 PLC 连接。" : "No PLC connections configured."}
                        </td>
                      </tr>
                    )}
                    {connections.map((connection, index) => {
                      const liveStatus =
                        modbusStatuses[modbusStatusKey(connection)];
                      const status = connectionDisplayStatus(
                        connection,
                        liveStatus,
                      );
                      const error = connectionDisplayError(
                        connection,
                        liveStatus,
                      );
                      return (
                        <Fragment key={connectionKey(connection)}>
                          <tr
                            className={
                              expandedIndex === index ? "fwe-expanded" : ""
                            }
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
                            <td className="fwe-connection-details" />
                            <td>
                              <ConnectionStatus
                                status={status}
                                error={error}
                                zh={zh}
                              />
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
                                      setDeleteTarget(connection);
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
                            >
                              <td colSpan={8}>
                                <ConnectionDetails
                                  connection={connection}
                                  s7Status={s7Statuses[connection.id]}
                                  error={error}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="fwe-section-heading fwe-mqtt-heading">
                <h2>{zh ? "MQTT 连接" : "MQTT Connection"}</h2>
              </div>
              <div className="fwe-table-scroll">
                <table className="fwe-table fwe-mqtt-table">
                  <thead>
                    <tr>
                      <th className="fwe-icon-cell" />
                      <th>Id</th>
                      <th>URI</th>
                      <th>{zh ? "状态" : "Status"}</th>
                      <th className="fwe-menu-cell" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="fwe-icon-cell" />
                      <td>{mqttSummary?.clientId || "—"}</td>
                      <td>
                        {mqttSummary
                          ? `${mqttSummary.protocol}${mqttSummary.host}:${mqttSummary.port}`
                          : zh
                            ? "未配置"
                            : "Not configured"}
                      </td>
                      <td>
                        <ConnectionStatus
                          status={mqttSummary?.status ?? "disconnected"}
                          zh={zh}
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
              {asset} dashboard is ready to be connected.
            </p>
          </section>
        )}
      </main>
      <AppFooter onVersionClick={() => notify("Festo AX Connector v24.0.6")} />
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
              Do you want to delete &quot;{deleteTarget.id}&quot;
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
                  void deleteConnection(deleteTarget);
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
