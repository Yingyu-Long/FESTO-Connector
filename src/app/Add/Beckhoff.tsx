import { useState } from "react";
import { IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";
import { saveCurrentConfiguration } from "../configurationApi";

export default function Beckhoff() {
  const location = useLocation();
  const navigate = useNavigate();
  const editConnection = (location.state as { connection?: SavedConnection } | null)?.connection;
  const [values, setValues] = useState({
    id: editConnection?.id ?? "",
    host: editConnection?.host ?? "",
    port: configString(editConnection, "port", editConnection?.port ?? "48898"),
    targetNetId: configString(editConnection, "targetNetId", ""),
    targetPort: configString(editConnection, "targetPort", "851"),
    sourceNetId: configString(editConnection, "sourceNetId", ""),
    sourcePort: configString(editConnection, "sourcePort", "32905"),
    polling: configString(editConnection, "polling", "500"),
  });
  const [mode, setMode] = useState(configString(editConnection, "mode", "Automatic"));
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
    values.targetNetId &&
    values.targetPort &&
    values.sourceNetId &&
    values.sourcePort &&
    values.polling,
  );
  const save = async () => {
    setSubmitted(true);
    if (!valid) return;
    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "ads",
      host: values.host,
      port: values.port,
      details: `target-net-id: ${values.targetNetId}, target-port: ${values.targetPort}, source-net-id: ${values.sourceNetId}, source-port: ${values.sourcePort}, mode: ${mode}, polling: ${values.polling} ms`,
      status: "disconnected",
      editPath: "/add/beckhoff",
      config: { ...values, mode },
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
                PLC Details – <span>beckhoff</span>
              </h1>
            </div>
            <Field
              label="Id"
              value={values.id}
              onChange={set("id")}
              invalid={submitted && !values.id}
              help="Please type in an Id for this PLC"
            />
            <div className="fwe-siemens-fields">
              <SelectField
                label="Protocol"
                value="ads://"
                onChange={() => undefined}
                options={["ads://"]}
              />
              <Field
                label="Hostname or IP (PLC)"
                value={values.host}
                onChange={set("host")}
                invalid={submitted && !values.host}
              />
              <Field
                label="Port"
                value={values.port}
                onChange={set("port")}
                invalid={submitted && !values.port}
              />
              <Field
                label="Target NetId (PLC)"
                value={values.targetNetId}
                onChange={set("targetNetId")}
                invalid={submitted && !values.targetNetId}
              />
              <Field
                label="Target Port (PLC)"
                value={values.targetPort}
                onChange={set("targetPort")}
                invalid={submitted && !values.targetPort}
              />
              <Field
                label="Source NetId"
                value={values.sourceNetId}
                onChange={set("sourceNetId")}
                invalid={submitted && !values.sourceNetId}
              />
              <Field
                label="Source Port"
                value={values.sourcePort}
                onChange={set("sourcePort")}
                invalid={submitted && !values.sourcePort}
              />
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
                  Please fill out all required fields correctly.
                </div>
              )}
            </div>
            <div className="fwe-beckhoff-scan">
              <SelectField
                label="Scanning mode for PLC"
                value={mode}
                onChange={setMode}
                options={["Automatic", "Custom"]}
              />
              <Field
                label="Default polling interval"
                value={values.polling}
                onChange={set("polling")}
                help="Interval in milliseconds"
                suffix="ms"
              />
            </div>
            {mode === "Automatic" && (
              <p className="fwe-scan-help">
                Automatic mode will scan all library instances with a default
                polling interval of 500 ms.
              </p>
            )}
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
