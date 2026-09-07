import { useState } from "react";
import { LoadingIndicator } from "@festo-ui/react";
import { IconConnected, IconFailure, IconPlus } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, saveConnection } from "./storage";
import type { SavedConnection } from "./storage";
import { saveCurrentConfiguration } from "../configurationApi";

type ModbusRegister = {
  id: number;
  name: string;
  registerType: string;
  address: string;
  dataType: string;
};

function isModbusRegister(value: unknown): value is ModbusRegister {
  if (typeof value !== "object" || value === null) return false;
  const register = value as Partial<ModbusRegister>;
  return (
    typeof register.id === "number" &&
    typeof register.name === "string" &&
    typeof register.registerType === "string" &&
    typeof register.address === "string" &&
    typeof register.dataType === "string"
  );
}

function createRegister(id: number): ModbusRegister {
  return {
    id,
    name: "",
    registerType: "Holding register",
    address: "",
    dataType: "UInt16",
  };
}

export default function Modbus() {
  const location = useLocation();
  const navigate = useNavigate();
  const editConnection = (
    location.state as { connection?: SavedConnection } | null
  )?.connection;
  const [values, setValues] = useState({
    id: editConnection?.id ?? "",
    host: editConnection?.host ?? "",
    port: configString(editConnection, "port", editConnection?.port ?? "502"),
    unitId: configString(editConnection, "unitId", "1"),
    timeout: configString(editConnection, "timeout", "3000"),
    polling: configString(editConnection, "polling", "500"),
  });
  const [registers, setRegisters] = useState<ModbusRegister[]>(() => {
    const saved = editConnection?.config?.registers;
    const parsed = Array.isArray(saved) ? saved.filter(isModbusRegister) : [];
    return parsed.length > 0 ? parsed : [createRegister(0)];
  });
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [testing, setTesting] = useState(false);
  const [connectionError, setConnectionError] = useState("");

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setRegister =
    (id: number, key: keyof Omit<ModbusRegister, "id">) => (value: string) =>
      setRegisters((current) =>
        current.map((register) =>
          register.id === id ? { ...register, [key]: value } : register,
        ),
      );
  const valid = Boolean(
    values.id &&
    values.host &&
    values.port &&
    values.unitId &&
    values.timeout &&
    values.polling &&
    registers.length > 0 &&
    registers.every((register) => register.name && register.address),
  );
  const testConnection = async () => {
    setTested(true);
    setConnectionError("");
    if (!valid) return;

    setTesting(true);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setConnectionError("Modbus backend driver is not enabled yet.");
    setTesting(false);
  };
  const save = async () => {
    setSubmitted(true);
    if (!valid) return;

    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "modbus.tcp",
      host: values.host,
      port: values.port,
      details: `unit-id: ${values.unitId}, timeout: ${values.timeout} ms, polling: ${values.polling} ms, registers: ${registers.map((register) => register.name).join(", ")}`,
      status: "disconnected",
      editPath: "/add/modbus",
      config: { ...values, registers },
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
                PLC Details - <span>Modbus TCP</span>
              </h1>
            </div>
            <Field
              label="Id"
              value={values.id}
              onChange={set("id")}
              invalid={submitted && !values.id}
              help="Please type in an Id for this PLC"
            />
            <div className="fwe-siemens-fields fwe-modbus-connection-fields">
              <SelectField
                label="Protocol"
                value="modbus.tcp://"
                onChange={() => undefined}
                options={["modbus.tcp://"]}
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
                label="Unit ID"
                value={values.unitId}
                onChange={set("unitId")}
                invalid={submitted && !values.unitId}
              />
              <Field
                label="Connection timeout"
                value={values.timeout}
                onChange={set("timeout")}
                invalid={submitted && !values.timeout}
                suffix="ms"
              />
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
                  Please fill out all required fields correctly.
                </div>
              )}
              {connectionError && (
                <span className="fwe-status">
                  <IconFailure aria-hidden="true" />
                  {connectionError}
                </span>
              )}
            </div>
            <div className="fwe-data-heading">
              <h2>Modbus registers</h2>
            </div>
            <p className="fwe-modbus-help">
              Use the zero-based register address required by the Modbus device.
            </p>
            <div className="fwe-modbus-registers">
              {registers.map((register) => (
                <div className="fwe-modbus-register-row" key={register.id}>
                  <Field
                    label="Name"
                    value={register.name}
                    onChange={setRegister(register.id, "name")}
                    invalid={submitted && !register.name}
                  />
                  <SelectField
                    label="Register type"
                    value={register.registerType}
                    onChange={setRegister(register.id, "registerType")}
                    options={[
                      "Coil",
                      "Discrete input",
                      "Input register",
                      "Holding register",
                    ]}
                  />
                  <Field
                    label="Address"
                    value={register.address}
                    onChange={setRegister(register.id, "address")}
                    invalid={submitted && !register.address}
                  />
                  <SelectField
                    label="Data type"
                    value={register.dataType}
                    onChange={setRegister(register.id, "dataType")}
                    options={[
                      "Boolean",
                      "Int16",
                      "UInt16",
                      "Int32",
                      "UInt32",
                      "Float32",
                    ]}
                  />
                  <button
                    type="button"
                    className="fwe-delete-button"
                    aria-label={`Remove ${register.name || "register"}`}
                    disabled={registers.length === 1}
                    onClick={() =>
                      setRegisters((current) =>
                        current.filter((item) => item.id !== register.id),
                      )
                    }
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="fwe-add-more"
              onClick={() =>
                setRegisters((current) => [
                  ...current,
                  createRegister(
                    Math.max(...current.map((register) => register.id), -1) + 1,
                  ),
                ])
              }
            >
              <IconPlus />
              Add register
            </button>
            <div className="fwe-modbus-polling">
              <Field
                label="Polling interval"
                value={values.polling}
                onChange={set("polling")}
                invalid={submitted && !values.polling}
                help="Interval in milliseconds"
                suffix="ms"
              />
            </div>
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
