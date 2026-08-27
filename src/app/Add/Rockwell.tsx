import { useState } from "react";
import { IconConnected, IconFailure, IconPlus } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";

export default function Rockwell() {
  const location = useLocation();
  const navigate = useNavigate();
  const editConnection = (location.state as { connection?: SavedConnection } | null)?.connection;
  const [values, setValues] = useState({
    id: editConnection?.id ?? "",
    host: editConnection?.host ?? "",
    port: configString(editConnection, "port", editConnection?.port ?? "44818"),
    backplane: configString(editConnection, "backplane", "0"),
    slot: configString(editConnection, "slot", "0"),
    dataBlock: configString(editConnection, "dataBlock", ""),
    polling: configString(editConnection, "polling", ""),
  });
  const [endian, setEndian] = useState(configString(editConnection, "endian", "Little-Endian"));
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [rows, setRows] = useState([0]);
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
    values.backplane &&
    values.slot &&
    values.dataBlock &&
    values.polling,
  );
  const save = () => {
    setSubmitted(true);
    if (!valid) return;
    const connection: SavedConnection = {
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "eip",
      host: values.host,
      port: values.port,
      details: `backplane: ${values.backplane}, slot: ${values.slot}, endian: ${endian}, data-blocks: ${values.dataBlock}, polling: ${values.polling} ms`,
      status: "disconnected",
      editPath: "/add/rockwell",
      config: { ...values, endian },
    };
    saveConnection(connection);
    navigate("/dashboard");
  };
  return (
    <PlcShell>
      <div className="fwe-add-layout">
        <section className="fwe-siemens-card">
          <form onSubmit={(event) => event.preventDefault()}>
            <div className="fwe-form-title">
              <h1>
                PLC Details – <span>rockwell</span>
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
                value="eip://"
                onChange={() => undefined}
                options={["eip://"]}
              />
              <Field
                label="Hostname or IP"
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
                label="Backplane"
                value={values.backplane}
                onChange={set("backplane")}
                invalid={submitted && !values.backplane}
              />
              <Field
                label="Slot"
                value={values.slot}
                onChange={set("slot")}
                invalid={submitted && !values.slot}
              />
              <SelectField
                label="Endian"
                value={endian}
                onChange={setEndian}
                options={["Little-Endian", "Big-Endian"]}
              />
            </div>
            <div className="fwe-test-row">
              <button
                type="button"
                className="fwe-test-button"
                onClick={() => {
                  setTested(true);
                }}
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
            <div className="fwe-data-heading">
              <h2>Data blocks</h2>
            </div>
            <div className="fwe-data-blocks">
              {rows.map((row, index) => (
                <div className="fwe-data-block-row" key={row}>
                  <Field
                    label="Data block(s)"
                    value={index === 0 ? values.dataBlock : ""}
                    onChange={index === 0 ? set("dataBlock") : () => undefined}
                    invalid={submitted && index === 0 && !values.dataBlock}
                    help="Custom range e.g. 1-200 or number"
                  />
                  <Field
                    label="Polling interval"
                    value={index === 0 ? values.polling : ""}
                    onChange={index === 0 ? set("polling") : () => undefined}
                    invalid={submitted && index === 0 && !values.polling}
                    help="Interval in milliseconds"
                    suffix="ms"
                  />
                  <button
                    type="button"
                    className="fwe-delete-button"
                    aria-label="Remove data block"
                    disabled={rows.length === 1}
                    onClick={() => setRows(rows.filter((item) => item !== row))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="fwe-add-more"
              onClick={() => setRows([...rows, rows.length])}
            >
              <IconPlus />
              Add more
            </button>
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
