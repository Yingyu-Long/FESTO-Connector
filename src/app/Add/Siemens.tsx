import { useState } from "react";
import { IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { saveConnection } from "./storage";

type DataBlock = {
  id: number;
  dataBlock: string;
  polling: string;
};

export default function Siemens() {
  const navigate = useNavigate();
  const [values, setValues] = useState({
    id: "",
    host: "",
    port: "102",
    rack: "0",
    slot: "1",
  });
  const [dataBlocks, setDataBlocks] = useState<DataBlock[]>([
    { id: 0, dataBlock: "", polling: "" },
  ]);
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setDataBlock =
    (index: number, key: "dataBlock" | "polling") => (value: string) =>
      setDataBlocks((current) =>
        current.map((item, itemIndex) =>
          itemIndex === index ? { ...item, [key]: value } : item,
        ),
      );
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
    values.rack &&
    values.slot &&
    dataBlocks.every((item) => item.dataBlock && item.polling),
  );
  const save = () => {
    setSubmitted(true);
    if (!valid) return;
    saveConnection({
      id: values.id,
      protocol: "s7",
      host: values.host,
      port: values.port,
      details: `remote-rack: ${values.rack}, remote-slot: ${values.slot}, data-blocks: ${dataBlocks.map((item) => `${item.dataBlock}, polling: ${item.polling} ms`).join("; ")}`,
      status: "disconnected",
    });
    navigate("/dashboard");
  };
  return (
    <PlcShell>
      <div className="fwe-add-layout">
        <section className="fwe-siemens-card">
          <form onSubmit={(event) => event.preventDefault()}>
            <div className="fwe-form-title">
              <h1>
                PLC Details – <span>Siemens</span>
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
                value="s7://"
                onChange={() => undefined}
                options={["s7://"]}
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
                label="Rack"
                value={values.rack}
                onChange={set("rack")}
                invalid={submitted && !values.rack}
              />
              <Field
                label="Slot"
                value={values.slot}
                onChange={set("slot")}
                invalid={submitted && !values.slot}
              />
            </div>
            <div className="fwe-test-row">
              <button
                type="button"
                className="fwe-test-button"
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
            <div className="fwe-data-heading">
              <h2>Data blocks</h2>
            </div>
            <div className="fwe-data-blocks">
              {dataBlocks.map((item, index) => (
                <div className="fwe-data-block-row" key={item.id}>
                  <Field
                    label="Data block(s)"
                    value={item.dataBlock}
                    onChange={setDataBlock(index, "dataBlock")}
                    invalid={submitted && !item.dataBlock}
                    help="Custom range e.g. 1-200 or number"
                  />
                  <Field
                    label="Polling interval"
                    value={item.polling}
                    onChange={setDataBlock(index, "polling")}
                    invalid={submitted && !item.polling}
                    help="Interval in milliseconds"
                    suffix="ms"
                  />
                </div>
              ))}
            </div>
            <button
              type="button"
              className="fwe-add-more"
              onClick={() =>
                setDataBlocks((current) => [
                  ...current,
                  { id: current.length, dataBlock: "", polling: "" },
                ])
              }
            >
              ＋ Add more
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
