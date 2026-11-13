import { useState } from "react";
import type { DragEvent } from "react";
import { Button, LoadingIndicator } from "@festo-ui/react";
import {
  IconCheckStatus,
  IconConnected,
  IconFailure,
  IconPlus,
} from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, readMqttConfig, saveConnection } from "../storage";
import type { SavedConnection } from "../storage";
import { connectPlc, saveCurrentConfiguration } from "../configurationApi";
import { isValidMqttPublishTopic } from "../../../shared/mqttTopic.js";

type BrowsedNode = {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: string;
  selectable: boolean;
};

type SelectedNode = {
  nodeId: string;
  displayName: string;
};

type OpcuaDataBlock = {
  key: string;
  name: string;
  mqttTopic: string;
  nodes: SelectedNode[];
};

function readNodes(value: unknown, nodeIdsValue?: unknown): SelectedNode[] {
  const nodes = Array.isArray(value) ? value : [];
  const parsed = nodes.flatMap((node) => {
    if (typeof node !== "object" || node === null) return [];
    const item = node as Record<string, unknown>;
    if (typeof item.nodeId !== "string") return [];
    return [{
      nodeId: item.nodeId,
      displayName: typeof item.displayName === "string" ? item.displayName : item.nodeId,
    }];
  });
  if (parsed.length > 0) return parsed;
  return Array.isArray(nodeIdsValue)
    ? nodeIdsValue.flatMap((nodeId) => typeof nodeId === "string" ? [{ nodeId, displayName: nodeId }] : [])
    : [];
}

function savedOpcuaDataBlocks(connection?: SavedConnection): OpcuaDataBlock[] {
  const config = connection?.config ?? {};
  const savedBlocks = config.dataBlocks;
  if (Array.isArray(savedBlocks) && savedBlocks.length > 0) {
    return savedBlocks.flatMap((raw, index) => {
      if (typeof raw !== "object" || raw === null) return [];
      const block = raw as Record<string, unknown>;
      const nodes = readNodes(block.nodes ?? block.selectedNodes, block.nodeIds);
      return [{
        key: typeof block.id === "string" ? block.id : crypto.randomUUID(),
        name: typeof block.name === "string" && block.name.trim() ? block.name : `Datablock ${index + 1}`,
        mqttTopic: typeof block.mqttTopic === "string" && block.mqttTopic.trim()
          ? block.mqttTopic
          : index === 0 && typeof config.mqttTopic === "string"
            ? config.mqttTopic
            : "",
        nodes,
      }];
    });
  }

  const nodes = readNodes(config.selectedNodes, config.nodeIds);
  return [{
    key: crypto.randomUUID(),
    name: "Datablock 1",
    mqttTopic: typeof config.mqttTopic === "string" ? config.mqttTopic : "",
    nodes,
  }];
}

function newDataBlock(index: number): OpcuaDataBlock {
  return {
    key: crypto.randomUUID(),
    name: `Datablock ${index + 1}`,
    mqttTopic: "",
    nodes: [],
  };
}

function effectiveTopic(block: OpcuaDataBlock, index: number, plcId: string) {
  const configured = block.mqttTopic.trim();
  if (configured) return configured;
  const base = `festo/plc/${plcId.trim() || "{PLC ID}"}`;
  return index === 0 ? base : `${base}/datablock-${index + 1}`;
}

type CertificateFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  accept: string;
};

function CertificateField({
  label,
  value,
  onChange,
  invalid,
  accept,
}: CertificateFieldProps) {
  return (
    <label
      className={`fwe-field fwe-opcua-certificate-field ${invalid ? "is-invalid" : ""}`}
    >
      <span>{label} *</span>
      <span className="fwe-input-wrap fwe-file-input-wrap">
        <input
          className="fwe-file-input"
          type="file"
          accept={accept}
          onChange={(event) => onChange(event.target.files?.[0]?.name ?? "")}
        />
        <span className={value ? "" : "is-placeholder"}>
          {value || "Choose file ..."}
        </span>
      </span>
      {invalid && <em>Required</em>}
    </label>
  );
}

export default function Opcua() {
  const location = useLocation();
  const navigate = useNavigate();
  const editConnection = (
    location.state as { connection?: SavedConnection } | null
  )?.connection;
  const [values, setValues] = useState({
    id: editConnection?.id ?? "",
    host: editConnection?.host ?? "",
    port: configString(editConnection, "port", editConnection?.port ?? "4840"),
    server: configString(editConnection, "server", ""),
    username: configString(editConnection, "username", ""),
    password: configString(editConnection, "password", ""),
  });
  const [securityMode, setSecurityMode] = useState(
    configString(editConnection, "securityMode", "NONE_MODE"),
  );
  const [securityPolicy, setSecurityPolicy] = useState(
    configString(editConnection, "securityPolicy", "NONE"),
  );
  const [certificates, setCertificates] = useState({
    rootCertificate: configString(editConnection, "rootCertificate", ""),
    clientCertificate: configString(editConnection, "clientCertificate", ""),
    clientKey: configString(editConnection, "clientKey", ""),
  });
  const [authType, setAuthType] = useState(
    configString(editConnection, "authType", "None"),
  );
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<SavedConnection["status"]>("disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [testing, setTesting] = useState(false);
  const [browseNodes, setBrowseNodes] = useState<BrowsedNode[]>([]);
  const [dropTargetBlockKey, setDropTargetBlockKey] = useState("");
  const [browsePath, setBrowsePath] = useState([
    { nodeId: "RootFolder", label: "Root" },
  ]);
  const [browsing, setBrowsing] = useState(false);
  const [dataBlocks, setDataBlocks] = useState<OpcuaDataBlock[]>(() =>
    savedOpcuaDataBlocks(editConnection),
  );
  const [activeBlockKey, setActiveBlockKey] = useState(
    () => dataBlocks[0]?.key ?? "",
  );
  const [polling, setPolling] = useState(
    configString(editConnection, "polling", "500"),
  );
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setCertificate = (key: keyof typeof certificates) => (value: string) =>
    setCertificates((current) => ({ ...current, [key]: value }));
  const usesSecurity = securityMode !== "NONE_MODE";
  const requiresCertificates = usesSecurity && securityPolicy !== "NONE";
  const certificatesValid =
    !usesSecurity ||
    (requiresCertificates &&
      Boolean(certificates.rootCertificate) &&
      Boolean(certificates.clientCertificate) &&
      Boolean(certificates.clientKey));
  const topicValid =
    dataBlocks.length > 0 &&
    dataBlocks.every((block, index) =>
      Boolean(block.name.trim()) && isValidMqttPublishTopic(effectiveTopic(block, index, values.id)),
    ) &&
    new Set(dataBlocks.map((block, index) => effectiveTopic(block, index, values.id))).size ===
      dataBlocks.length;
  const allSelectedNodes = dataBlocks.flatMap((block) => block.nodes);
  const selectedNodeIds = allSelectedNodes.map((node) => node.nodeId);
  const activeBlock = dataBlocks.find((block) => block.key === activeBlockKey);
  const updateSecurityMode = (value: string) => {
    setSecurityMode(value);
    if (value === "NONE_MODE") setSecurityPolicy("NONE");
  };
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
    topicValid &&
    certificatesValid &&
    (authType === "None" || (values.username && values.password)),
  );
  const subscriptionValid =
    valid &&
    dataBlocks.every((block) => block.nodes.length > 0) &&
    selectedNodeIds.length > 0 &&
    Boolean(polling);
  const updateDataBlock = (
    key: string,
    updates: Partial<Pick<OpcuaDataBlock, "name" | "mqttTopic">>,
  ) => {
    setDataBlocks((current) =>
      current.map((block) => block.key === key ? { ...block, ...updates } : block),
    );
  };
  const buildBackendConfig = () => {
    return {
      id: values.id,
      previousId: editConnection?.id,
      host: values.host,
      port: Number(values.port),
      server: values.server,
      securityMode,
      securityPolicy,
      authType,
      polling: Number(polling),
      nodeIds: selectedNodeIds,
      dataBlocks: dataBlocks.map((block, index) => ({
        id: block.key,
        name: block.name.trim(),
        mqttTopic: effectiveTopic(block, index, values.id),
        nodes: block.nodes,
        nodeIds: block.nodes.map((node) => node.nodeId),
      })),
      mqtt: readMqttConfig(),
    };
  };
  const testConnection = async () => {
    setTested(true);
    setConnectionError("");
    if (!valid) return;

    setTesting(true);
    try {
      const response = await fetch("/api/plcs/opcua/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBackendConfig()),
      });
      const result = (await response.json()) as {
        connected?: boolean;
        error?: string;
      };
      if (!response.ok || !result.connected) {
        setConnectionStatus("disconnected");
        setConnectionError(
          result.error ?? "Unable to connect to OPC UA server",
        );
        return;
      }
      setConnectionStatus("connected");
    } catch {
      setConnectionStatus("disconnected");
      setConnectionError("Unable to reach the PLC backend");
    } finally {
      setTesting(false);
    }
  };
  const browse = async (nodeId = "RootFolder", label = "Root") => {
    setBrowsing(true);
    setConnectionError("");
    try {
      const response = await fetch("/api/plcs/opcua/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildBackendConfig(), nodeId }),
      });
      const result = (await response.json()) as {
        nodes?: BrowsedNode[];
        error?: string;
      };
      if (!response.ok || !result.nodes) {
        setConnectionError(result.error ?? "Unable to browse OPC UA nodes");
        return;
      }
      setBrowseNodes(result.nodes);
      setBrowsePath((current) =>
        nodeId === "RootFolder"
          ? [{ nodeId, label }]
          : [...current, { nodeId, label }],
      );
    } catch {
      setConnectionError("Unable to reach the PLC backend");
    } finally {
      setBrowsing(false);
    }
  };
  const toggleNode = (nodeId: string, displayName: string) => {
    if (!activeBlockKey) return;
    const alreadyInActive = activeBlock?.nodes.some((node) => node.nodeId === nodeId);
    if (!alreadyInActive) {
      assignNodeToBlock(nodeId, displayName, activeBlockKey);
      return;
    }
    setDataBlocks((current) => current.map((block) => {
      return block.key === activeBlockKey
        ? { ...block, nodes: block.nodes.filter((node) => node.nodeId !== nodeId) }
        : block;
    }));
  };
  const assignNodeToBlock = (nodeId: string, displayName: string, targetKey: string) => {
    setDataBlocks((current) => current.map((block) => {
      const withoutNode = block.nodes.filter((node) => node.nodeId !== nodeId);
      return block.key === targetKey
        ? { ...block, nodes: [...withoutNode, { nodeId, displayName }] }
        : { ...block, nodes: withoutNode };
    }));
  };
  const dropNodeOnBlock = (event: DragEvent<HTMLElement>, targetKey: string) => {
    event.preventDefault();
    const rawNode = event.dataTransfer.getData("application/json") || event.dataTransfer.getData("text/plain");
    setDropTargetBlockKey("");
    if (!rawNode) return;
    try {
      const node = JSON.parse(rawNode) as { nodeId?: unknown; displayName?: unknown };
      if (typeof node.nodeId !== "string" || !node.nodeId) return;
      assignNodeToBlock(
        node.nodeId,
        typeof node.displayName === "string" ? node.displayName : node.nodeId,
        targetKey,
      );
    } catch {
      return;
    }
  };
  const connectToBackend = async () => {
    const result = await connectPlc(
      "/api/plcs/opcua/connect",
      buildBackendConfig(),
      "Unable to start OPC UA subscription",
    );
    setConnectionStatus(result.status);
    setConnectionError(result.connectionError ?? "");
    return result;
  };
  const save = async () => {
    setSubmitted(true);
    if (!subscriptionValid) return;
    const result = await connectToBackend();
    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "opc.tcp",
      host: values.host,
      port: values.port,
      details: `server: ${values.server || "default"}, security: ${securityMode}/${securityPolicy}, authentication: ${authType}`,
      ...result,
      config: {
        ...values,
        ...certificates,
        securityMode,
        securityPolicy,
        authType,
        mqttTopic: dataBlocks[0]?.mqttTopic.trim() ?? "",
        nodeIds: selectedNodeIds,
        selectedNodes: allSelectedNodes,
        dataBlocks: dataBlocks.map((block) => ({
          id: block.key,
          name: block.name.trim(),
          mqttTopic: block.mqttTopic.trim(),
          nodes: block.nodes,
          nodeIds: block.nodes.map((node) => node.nodeId),
        })),
        polling,
      },
    });
    await saveCurrentConfiguration();
    navigate("/dashboard");
  };
  return (
    <PlcShell>
      <div className="fwe-add-layout">
        <section className="fwe-siemens-card">
          <form onSubmit={(event) => event.preventDefault()}>
            <div className="fwe-form-title">
              <h1>
                PLC Details – <span>OPC UA</span>
              </h1>
            </div>
            <Field
              label="Id"
              value={values.id}
              onChange={set("id")}
              invalid={submitted && !values.id}
            />
            <div className="fwe-opcua-connection-fields">
              <SelectField
                className="fwe-opcua-protocol-field"
                label="Protocol"
                value="opc.tcp://"
                onChange={() => undefined}
                options={["opc.tcp://"]}
              />
              <Field
                className="fwe-opcua-host-field"
                label="Hostname or IP"
                value={values.host}
                onChange={set("host")}
                invalid={submitted && !values.host}
              />
              <Field
                className="fwe-opcua-port-field"
                label="Port"
                value={values.port}
                onChange={set("port")}
                invalid={submitted && !values.port}
              />
              <Field
                className="fwe-opcua-server-field"
                label="OPC UA Server Name"
                required={false}
                value={values.server}
                onChange={set("server")}
              />
            </div>
            <div className="fwe-opcua-security-fields">
              <SelectField
                className="fwe-opcua-security-mode-field"
                label="Message Security Mode"
                value={securityMode}
                onChange={updateSecurityMode}
                options={["NONE_MODE", "SIGN", "SIGN_AND_ENCRYPT"]}
              />
              {usesSecurity && (
                <SelectField
                  className="fwe-opcua-security-policy-field"
                  label="Security Policy"
                  value={securityPolicy}
                  onChange={setSecurityPolicy}
                  options={["NONE", "BASIC256SHA256", "BASIC256"]}
                  invalid={submitted && securityPolicy === "NONE"}
                />
              )}
            </div>
            {requiresCertificates && (
              <div className="fwe-opcua-certificates">
                <CertificateField
                  label="Root certificate"
                  value={certificates.rootCertificate}
                  onChange={setCertificate("rootCertificate")}
                  invalid={submitted && !certificates.rootCertificate}
                  accept=".cer,.crt,.der,.pem"
                />
                <CertificateField
                  label="Client certificate"
                  value={certificates.clientCertificate}
                  onChange={setCertificate("clientCertificate")}
                  invalid={submitted && !certificates.clientCertificate}
                  accept=".cer,.crt,.der,.pem"
                />
                <CertificateField
                  label="Client key"
                  value={certificates.clientKey}
                  onChange={setCertificate("clientKey")}
                  invalid={submitted && !certificates.clientKey}
                  accept=".key,.pem"
                />
              </div>
            )}
            <div className="fwe-opcua-auth">
              <div
                className="fwe-opcua-auth-options"
                role="radiogroup"
                aria-label="Authentication"
              >
                <label>
                  <input
                    type="radio"
                    name="opcua-authentication"
                    value="None"
                    checked={authType === "None"}
                    onChange={(event) => setAuthType(event.target.value)}
                  />
                  None
                </label>
                <label>
                  <input
                    type="radio"
                    name="opcua-authentication"
                    value="Basic Authentication"
                    checked={authType === "Basic Authentication"}
                    onChange={(event) => setAuthType(event.target.value)}
                  />
                  Basic Authentication
                </label>
              </div>
              {authType === "Basic Authentication" && (
                <div className="fwe-opcua-credentials">
                  <Field
                    label="Username"
                    value={values.username}
                    onChange={set("username")}
                    invalid={submitted && !values.username}
                  />
                  <Field
                    label="Password"
                    type="password"
                    value={values.password}
                    onChange={set("password")}
                    invalid={submitted && !values.password}
                  />
                </div>
              )}
            </div>
            <div className="fwe-test-row">
              <button
                type="button"
                className="fwe-btn no-wrap"
                aria-label="Test connection"
                onClick={() => void testConnection()}
                disabled={testing}
              >
                <IconConnected />
                Test connection
              </button>
              {testing && (
                <LoadingIndicator size="small">Loading ...</LoadingIndicator>
              )}
              {tested && !valid && (
                <div className="fwe-connection-error">
                  <IconFailure />
                  Please fill in all required fields to continue.
                </div>
              )}
              {tested && valid && connectionStatus === "connected" && (
                <span className="fwe-status fwe-status-connected">
                  <IconCheckStatus aria-hidden="true" />
                  Connected
                </span>
              )}
              {tested &&
                valid &&
                connectionStatus === "disconnected" &&
                connectionError && (
                  <div className="fwe-connection-error">
                    <IconFailure />
                    {connectionError}
                  </div>
                )}
            </div>
            <section
              className="fwe-opcua-browse"
              aria-labelledby="opcua-browse-heading"
            >
              <h2 id="opcua-browse-heading">Group variables into Datablocks</h2>
              <div className="fwe-opcua-datablocks">
                {dataBlocks.map((block, index) => (
                  <article
                    className={`fwe-opcua-datablock ${activeBlockKey === block.key ? "is-active" : ""} ${dropTargetBlockKey === block.key ? "is-drop-target" : ""}`}
                    key={block.key}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes("text/plain") && !event.dataTransfer.types.includes("application/json")) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTargetBlockKey(block.key);
                    }}
                    onDragLeave={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropTargetBlockKey("");
                      }
                    }}
                    onDrop={(event) => dropNodeOnBlock(event, block.key)}
                  >
                    <div className="fwe-opcua-datablock-heading">
                      <h3>Datablock {index + 1}</h3>
                      {dataBlocks.length > 1 && (
                        <button
                          type="button"
                          className="fwe-opcua-text-button"
                          onClick={() => {
                            const remaining = dataBlocks.filter((item) => item.key !== block.key);
                            setDataBlocks(remaining);
                            if (activeBlockKey === block.key) setActiveBlockKey(remaining[0].key);
                          }}
                        >
                          Remove group
                        </button>
                      )}
                    </div>
                    <div className="fwe-opcua-datablock-fields">
                      <Field
                        label="Group name"
                        value={block.name}
                        onChange={(name) => updateDataBlock(block.key, { name })}
                        invalid={submitted && !block.name.trim()}
                      />
                      <Field
                        label="MQTT topic"
                        value={block.mqttTopic}
                        onChange={(mqttTopic) => updateDataBlock(block.key, { mqttTopic })}
                        required={false}
                        placeholder={effectiveTopic(block, index, values.id)}
                      />
                    </div>
                    {submitted &&
                      (!isValidMqttPublishTopic(effectiveTopic(block, index, values.id)) ||
                        dataBlocks.some((other, otherIndex) => other.key !== block.key && effectiveTopic(other, otherIndex, values.id) === effectiveTopic(block, index, values.id))) && (
                        <p className="fwe-connection-error" role="alert">
                          Enter a valid, unique publish topic. Topics cannot contain + or # and must fit within 65535 UTF-8 bytes.
                        </p>
                      )}
                    <div className="fwe-opcua-datablock-selection">
                      <div>
                        <strong>{block.nodes.length} variables</strong>
                        {activeBlockKey !== block.key && (
                          <button type="button" onClick={() => setActiveBlockKey(block.key)}>
                            Choose variables for this group
                          </button>
                        )}
                      </div>
                      {dropTargetBlockKey === block.key && (
                        <div className="fwe-opcua-drop-hint">Drop variable into this Datablock</div>
                      )}
                      {block.nodes.length > 0 ? (
                        <ul>
                          {block.nodes.map((node) => (
                            <li key={node.nodeId}>
                              <span>{node.displayName}<code>{node.nodeId}</code></span>
                              <button
                                type="button"
                                aria-label={`Remove ${node.displayName} from ${block.name}`}
                                onClick={() => toggleNode(node.nodeId, node.displayName)}
                                disabled={activeBlockKey !== block.key}
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : submitted ? (
                        <p className="fwe-connection-error" role="alert">Add at least one variable to this Datablock.</p>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
              <button
                type="button"
                className="fwe-add-more fwe-opcua-add-datablock"
                onClick={() => {
                  const next = newDataBlock(dataBlocks.length);
                  setDataBlocks((current) => [...current, next]);
                  setActiveBlockKey(next.key);
                }}
              >
                <IconPlus /> Add Datablock
              </button>
              {!topicValid && submitted && (
                <p className="fwe-connection-error" role="alert">
                  Give every Datablock a valid, unique MQTT topic.
                </p>
              )}

              <h2 className="fwe-opcua-browse-nodes-heading">Choose OPC UA variables</h2>
              {tested && !valid && (
                <div className="fwe-opcua-error-ribbon" role="alert">
                  <IconFailure />
                  Please fill in all required fields to continue.
                </div>
              )}
              {connectionError && tested && valid && (
                <div className="fwe-opcua-error-ribbon" role="alert">
                  <IconFailure />
                  {connectionError}
                </div>
              )}
              <Button
                type="button"
                disabled={connectionStatus !== "connected" || browsing}
                onClick={() => void browse()}
              >
                {browsing ? "Browsing..." : "Start Browsing"}
              </Button>
              {browseNodes.length > 0 && (
                <div className="fwe-opcua-node-browser">
                  <div className="fwe-opcua-browser-header">
                    <span>Location: {browsePath.at(-1)?.label ?? "Root"}</span>
                    {browsePath.length > 1 && (
                      <button type="button" onClick={() => void browse()}>
                        Back to root
                      </button>
                    )}
                  </div>
                  {browseNodes.map((node) => (
                    <div className="fwe-opcua-node-row" key={node.nodeId}>
                      {node.selectable ? (
                        <label>
                          <input
                            type="checkbox"
                            checked={Boolean(activeBlock?.nodes.some((selected) => selected.nodeId === node.nodeId))}
                            onChange={() =>
                              toggleNode(node.nodeId, node.displayName)
                            }
                            disabled={!activeBlock}
                          />
                          <span
                            className="fwe-opcua-drag-handle"
                            aria-hidden="true"
                            title="Drag variable to a Datablock"
                            draggable
                            onDragStart={(event) => {
                              const selected = { nodeId: node.nodeId, displayName: node.displayName };
                              const payload = JSON.stringify(selected);
                              event.dataTransfer.setData("application/json", payload);
                              event.dataTransfer.setData("text/plain", payload);
                              event.dataTransfer.effectAllowed = "move";
                            }}
                          >
                            ⠿
                          </span>
                          <span>{node.displayName}</span>
                        </label>
                      ) : (
                        <span>{node.displayName}</span>
                      )}
                      <small>
                        {node.nodeClass} - {node.nodeId}
                        {dataBlocks.some((block) => block.key !== activeBlockKey && block.nodes.some((selected) => selected.nodeId === node.nodeId))
                          ? ` · In ${dataBlocks.find((block) => block.key !== activeBlockKey && block.nodes.some((selected) => selected.nodeId === node.nodeId))?.name ?? "another group"}`
                          : ""}
                      </small>
                      <button
                        type="button"
                        onClick={() =>
                          void browse(node.nodeId, node.displayName)
                        }
                      >
                        Browse
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="fwe-opcua-subscription-fields">
                <Field
                  label="Polling interval"
                  value={polling}
                  onChange={setPolling}
                  invalid={submitted && !polling}
                  suffix="ms"
                />
                <p>
                  Total variables selected: {selectedNodeIds.length}
                  {submitted &&
                    selectedNodeIds.length === 0 &&
                    " (add at least one variable)"}
                </p>
              </div>
            </section>
          </form>
        </section>
        <FormActions
          valid={subscriptionValid}
          onSave={save}
          onCancel={() => navigate(editConnection ? "/dashboard" : "/add")}
        />
      </div>
    </PlcShell>
  );
}
