import { useState } from "react";
import { Button } from "@festo-ui/react";
import { IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";
import { saveCurrentConfiguration } from "../configurationApi";

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
  const [authType, setAuthType] = useState(configString(editConnection, "authType", "None"));
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
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
      details: `server: ${values.server || "default"}, security: ${securityMode}, authentication: ${authType}`,
      status: "disconnected",
      editPath: "/add/opcua",
      config: { ...values, securityMode, authType },
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
                onChange={setSecurityMode}
                options={["NONE_MODE", "SIGN", "SIGN_AND_ENCRYPT"]}
              />
            </div>
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
