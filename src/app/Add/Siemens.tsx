import { useState } from "react";
import { IconCheckStatus, IconConnected, IconFailure } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";
import { saveCurrentConfiguration } from "../configurationApi";

type DataBlock = {
  id: number;
  dataBlock: string;
  polling: string;
  size?: string;
};

function isDataBlock(value: unknown): value is DataBlock {
  if (typeof value !== "object" || value === null) return false;
  const dataBlock = value as Partial<DataBlock>;
  return typeof dataBlock.id === "number" && typeof dataBlock.dataBlock === "string" && typeof dataBlock.polling === "string";
}

export default function Siemens() {
  const location = useLocation();
  const navigate = useNavigate();
  const editConnection = (location.state as { connection?: SavedConnection } | null)?.connection;
  const savedBlocks = editConnection?.config?.dataBlocks;
  const [values, setValues] = useState({
    id: editConnection?.id ?? "",
    host: editConnection?.host ?? "",
    port: configString(editConnection, "port", editConnection?.port ?? "102"),
    rack: configString(editConnection, "rack", "0"),
    slot: configString(editConnection, "slot", "1"),
  });
  const [dataBlocks, setDataBlocks] = useState<DataBlock[]>([
    ...(Array.isArray(savedBlocks) ? savedBlocks.filter(isDataBlock) : []),
    ...(!Array.isArray(savedBlocks) || savedBlocks.filter(isDataBlock).length === 0
      ? [{ id: 0, dataBlock: "", polling: "" }]
      : []),
  ]);
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<SavedConnection["status"]>("disconnected");
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
      rack: Number(values.rack),
      slot: Number(values.slot),
      polling: Number(dataBlocks[0]?.polling ?? 500),
      dataBlocks: dataBlocks.map((item) => ({
        range: item.dataBlock,
        polling: Number(item.polling),
        ...(item.size ? { size: Number(item.size) } : {}),
      })),
      mqtt,
      mqttTopic: `festo/plc/${values.id}`,
    };
  };
  const connectToBackend = async () => {
    try {
      const response = await fetch("/api/plcs/siemens/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBackendConfig()),
      });
      const result = (await response.json()) as { connected?: boolean };
      const status = response.ok && result.connected ? "connected" : "disconnected";
      setConnectionStatus(status);
      return status;
    } catch {
      setConnectionStatus("disconnected");
      return "disconnected" as const;
    }
  };
  const save = async () => {
    setSubmitted(true);
    if (!valid) return;
    const status = await connectToBackend();
    saveConnection({
      id: values.id,
      recordId: editConnection?.recordId,
      protocol: "s7",
      host: values.host,
      port: values.port,
      details: `remote-rack: ${values.rack}, remote-slot: ${values.slot}, data-blocks: ${dataBlocks.map((item) => `${item.dataBlock}, polling: ${item.polling} ms`).join("; ")}`,
      status,
      editPath: "/add/siemens",
      config: { ...values, dataBlocks },
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
                onClick={async () => {
                  setTested(true);
                  if (valid) await connectToBackend();
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
              {tested && valid && connectionStatus === "connected" && (
                <span className="fwe-status fwe-status-connected">
                  <IconCheckStatus />
                  Connected
                </span>
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
