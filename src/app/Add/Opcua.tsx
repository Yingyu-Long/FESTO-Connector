import { useState } from "react";
import { Button } from "@festo-ui/react";
import { IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";
import { saveCurrentConfiguration } from "../configurationApi";

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
  const save = async () => {
    setSubmitted(true);
    if (!valid) return;
    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "opc.tcp",
      host: values.host,
      port: values.port,
      details: `server: ${values.server || "default"}, security: ${securityMode}/${securityPolicy}, authentication: ${authType}`,
      status: "disconnected",
      editPath: "/add/opcua",
      config: {
        ...values,
        ...certificates,
        securityMode,
        securityPolicy,
        authType,
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
                onClick={() => setTested(true)}
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
            </div>
            <section className="fwe-opcua-browse" aria-labelledby="opcua-browse-heading">
              <h2 id="opcua-browse-heading">Browse Nodes</h2>
              {tested && !valid && (
                <div className="fwe-opcua-error-ribbon" role="alert">
                  <IconFailure />
                  Please fill in all required fields to continue.
                </div>
              )}
              <p>You can browse nodes after a successful connection test.</p>
              <Button
                type="button"
                disabled
                title="OPC UA node browsing is not implemented by the backend yet"
              >
                Start Browsing
              </Button>
            </section>
          </form>
        </section>
        <FormActions
          valid={valid}
          onSave={save}
          onCancel={() => navigate("/add")}
        />
      </div>
    </PlcShell>
  );
}
