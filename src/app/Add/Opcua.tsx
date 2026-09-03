import { useState } from "react";
import { Button } from "@festo-ui/react";
import { IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";
import { saveCurrentConfiguration } from "../configurationApi";

type BrowsedNode = {
  nodeId: string;
  browseName: string;
  displayName: string;
  nodeClass: string;
  selectable: boolean;
};

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
    <label className={`fwe-field fwe-opcua-certificate-field ${invalid ? "is-invalid" : ""}`}>
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
  const editConnection = (location.state as { connection?: SavedConnection } | null)?.connection;
  const [values, setValues] = useState({
    id: editConnection?.id ?? "",
    host: editConnection?.host ?? "",
    port: configString(editConnection, "port", editConnection?.port ?? "4840"),
    server: configString(editConnection, "server", ""),
    username: configString(editConnection, "username", ""),
    password: configString(editConnection, "password", ""),
  });
  const [securityMode, setSecurityMode] = useState(configString(editConnection, "securityMode", "NONE_MODE"));
  const [securityPolicy, setSecurityPolicy] = useState(configString(editConnection, "securityPolicy", "NONE"));
  const [certificates, setCertificates] = useState({
    rootCertificate: configString(editConnection, "rootCertificate", ""),
    clientCertificate: configString(editConnection, "clientCertificate", ""),
    clientKey: configString(editConnection, "clientKey", ""),
  });
  const [authType, setAuthType] = useState(configString(editConnection, "authType", "None"));
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<SavedConnection["status"]>("disconnected");
  const [connectionError, setConnectionError] = useState("");
  const [browseNodes, setBrowseNodes] = useState<BrowsedNode[]>([]);
  const [browsePath, setBrowsePath] = useState([
    { nodeId: "RootFolder", label: "Root" },
  ]);
  const [browsing, setBrowsing] = useState(false);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(() => {
    const saved = editConnection?.config?.nodeIds;
    return Array.isArray(saved)
      ? saved.filter((nodeId): nodeId is string => typeof nodeId === "string")
      : [];
  });
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
  const updateSecurityMode = (value: string) => {
    setSecurityMode(value);
    if (value === "NONE_MODE") setSecurityPolicy("NONE");
  };
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
    certificatesValid &&
    (authType === "None" || (values.username && values.password)),
  );
  const subscriptionValid = valid && selectedNodeIds.length > 0 && Boolean(polling);
  const buildBackendConfig = () => {
    let mqtt: Record<string, unknown> | undefined;
    try {
      const savedMqtt = JSON.parse(
        localStorage.getItem("festo-mqtt-config") ?? "null",
      ) as Record<string, unknown> | null;
      if (savedMqtt && typeof savedMqtt.host === "string" && savedMqtt.host) {
        mqtt = savedMqtt;
      }
    } catch {
      mqtt = undefined;
    }

    return {
      id: values.id,
      host: values.host,
      port: Number(values.port),
      server: values.server,
      securityMode,
      securityPolicy,
      authType,
      polling: Number(polling),
      nodeIds: selectedNodeIds,
      mqtt,
      mqttTopic: `festo/plc/${values.id}`,
    };
  };
  const testConnection = async () => {
    setTested(true);
    setConnectionError("");
    if (!valid) return;

    try {
      const response = await fetch("/api/plcs/opcua/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBackendConfig()),
      });
      const result = (await response.json()) as { connected?: boolean; error?: string };
      if (!response.ok || !result.connected) {
        setConnectionStatus("disconnected");
        setConnectionError(result.error ?? "Unable to connect to OPC UA server");
        return;
      }
      setConnectionStatus("connected");
    } catch {
      setConnectionStatus("disconnected");
      setConnectionError("Unable to reach the PLC backend");
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
      const result = (await response.json()) as { nodes?: BrowsedNode[]; error?: string };
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
  const toggleNode = (nodeId: string) => {
    setSelectedNodeIds((current) =>
      current.includes(nodeId)
        ? current.filter((item) => item !== nodeId)
        : [...current, nodeId],
    );
  };
  const connectToBackend = async () => {
    const response = await fetch("/api/plcs/opcua/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBackendConfig()),
    });
    const result = (await response.json()) as { connected?: boolean; error?: string };
    if (!response.ok || !result.connected) {
      throw new Error(result.error ?? "Unable to start OPC UA subscription");
    }
    return "connected" as const;
  };
  const save = async () => {
    setSubmitted(true);
    if (!subscriptionValid) return;
    const status = await connectToBackend();
    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "opc.tcp",
      host: values.host,
      port: values.port,
      details: `server: ${values.server || "default"}, security: ${securityMode}/${securityPolicy}, authentication: ${authType}`,
      status,
      editPath: "/add/opcua",
      config: {
        ...values,
        ...certificates,
        securityMode,
        securityPolicy,
        authType,
        nodeIds: selectedNodeIds,
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
              help="Please type in an Id for this PLC"
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
              <div className="fwe-opcua-auth-options" role="radiogroup" aria-label="Authentication">
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
              >
                <IconConnected />
                Test connection
              </button>
              {tested && !valid && (
                <div className="fwe-connection-error">
                  <IconFailure />
                  Please fill in all required fields to continue.
                </div>
              )}
              {tested && valid && connectionStatus === "connected" && (
                <span className="fwe-status fwe-status-connected">
                  <IconConnected aria-hidden="true" />
                  Connected
                </span>
              )}
              {tested && valid && connectionStatus === "disconnected" && connectionError && (
                <div className="fwe-connection-error">
                  <IconFailure />
                  {connectionError}
                </div>
              )}
            </div>
            <section className="fwe-opcua-browse" aria-labelledby="opcua-browse-heading">
              <h2 id="opcua-browse-heading">Browse Nodes</h2>
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
              <p>You can browse nodes after a successful connection test.</p>
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
                            checked={selectedNodeIds.includes(node.nodeId)}
                            onChange={() => toggleNode(node.nodeId)}
                          />
                          <span>{node.displayName}</span>
                        </label>
                      ) : (
                        <span>{node.displayName}</span>
                      )}
                      <small>{node.nodeClass} - {node.nodeId}</small>
                      <button
                        type="button"
                        onClick={() => void browse(node.nodeId, node.displayName)}
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
                  Selected variables: {selectedNodeIds.length}
                  {submitted && selectedNodeIds.length === 0 && " (select at least one NodeId)"}
                </p>
              </div>
            </section>
          </form>
        </section>
        <FormActions
          valid={subscriptionValid}
          onSave={save}
          onCancel={() => navigate("/add")}
        />
      </div>
    </PlcShell>
  );
}
