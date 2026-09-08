import { useState } from "react";
import { LoadingIndicator } from "@festo-ui/react";
import {
  IconCheckStatus,
  IconConnected,
  IconFailure,
  IconPlus,
} from "@festo-ui/react-icons";
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

function isIntegerBetween(value: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
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
  const [connectionStatus, setConnectionStatus] =
    useState<SavedConnection["status"]>("disconnected");

  const set = (key: keyof typeof values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setRegister =
    (id: number, key: keyof Omit<ModbusRegister, "id">) => (value: string) =>
      setRegisters((current) =>
        current.map((register) => {
          if (register.id !== id) return register;
          const updated = { ...register, [key]: value } as ModbusRegister;
          if (
            key === "registerType" &&
            ["Coil", "Discrete input"].includes(value)
          ) {
            updated.dataType = "Boolean";
          }
          return updated;
        }),
      );
  const portValid = isIntegerBetween(values.port, 1, 65535);
  const unitIdValid = isIntegerBetween(values.unitId, 0, 255);
  const timeoutValid = isIntegerBetween(values.timeout, 100, 60000);
  const pollingValid = isIntegerBetween(values.polling, 100, 3600000);
  const registerNames = registers.map((register) =>
    register.name.trim().toLowerCase(),
  );
  const registerNamesUnique =
    new Set(registerNames.filter(Boolean)).size ===
    registerNames.filter(Boolean).length;
  const registersValid = registers.every(
    (register) =>
      register.name.trim() &&
      isIntegerBetween(register.address, 0, 65535) &&
      (!["Coil", "Discrete input"].includes(register.registerType) ||
        register.dataType === "Boolean"),
  );
  const valid = Boolean(
    values.id &&
      values.host &&
      portValid &&
      unitIdValid &&
      timeoutValid &&
      pollingValid &&
      registers.length > 0 &&
      registersValid &&
      registerNamesUnique,
  );
  const testConnection = async () => {
    setTested(true);
    setConnectionError("");
    if (!valid) return;

    setTesting(true);
    try {
      const response = await fetch("/api/plcs/modbus/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBackendConfig()),
      });
      const result = (await response.json()) as {
        connected?: boolean;
        error?: string;
      };
      const connected = response.ok && result.connected;
      setConnectionStatus(connected ? "connected" : "disconnected");
      setConnectionError(
        connected
          ? ""
          : (result.error ?? "Unable to connect to Modbus TCP device"),
      );
    } catch {
      setConnectionStatus("disconnected");
      setConnectionError("Unable to reach the PLC backend");
    } finally {
      setTesting(false);
    }
  };
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
      previousId: editConnection?.id,
      host: values.host,
      port: Number(values.port),
      unitId: Number(values.unitId),
      timeout: Number(values.timeout),
      polling: Number(values.polling),
      registers: registers.map((register) => ({
        ...register,
        address: Number(register.address),
      })),
      mqtt,
      mqttTopic: `festo/plc/${values.id}`,
    };
  };
  const connectToBackend = async () => {
    try {
      const response = await fetch("/api/plcs/modbus/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBackendConfig()),
      });
      const result = (await response.json()) as {
        connected?: boolean;
        error?: string;
      };
      const status =
        response.ok && result.connected ? "connected" : "disconnected";
      setConnectionStatus(status);
      setConnectionError(
        status === "connected"
          ? ""
          : (result.error ?? "Unable to start Modbus polling"),
      );
      return status;
    } catch {
      setConnectionStatus("disconnected");
      setConnectionError("Unable to reach the PLC backend");
      return "disconnected" as const;
    }
  };
  const save = async () => {
    setSubmitted(true);
    if (!valid) return;

    const status = await connectToBackend();
    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "modbus.tcp",
      host: values.host,
      port: values.port,
      details: `unit-id: ${values.unitId}, timeout: ${values.timeout} ms, polling: ${values.polling} ms, registers: ${registers.map((register) => register.name).join(", ")}`,
      status,
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
                invalid={submitted && !portValid}
              />
              <Field
                label="Unit ID"
                value={values.unitId}
                onChange={set("unitId")}
                invalid={submitted && !unitIdValid}
              />
              <Field
                label="Connection timeout"
                value={values.timeout}
                onChange={set("timeout")}
                invalid={submitted && !timeoutValid}
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
                    invalid={
                      submitted &&
                      (!register.name.trim() ||
                        registerNames.filter(
                          (name) => name === register.name.trim().toLowerCase(),
                        ).length > 1)
                    }
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
                    invalid={
                      submitted &&
                      !isIntegerBetween(register.address, 0, 65535)
                    }
                  />
                  <SelectField
                    label="Data type"
                    value={register.dataType}
                    onChange={setRegister(register.id, "dataType")}
                    options={
                      ["Coil", "Discrete input"].includes(
                        register.registerType,
                      )
                        ? ["Boolean"]
                        : [
                            "Boolean",
                            "Int16",
                            "UInt16",
                            "Int32",
                            "UInt32",
                            "Float32",
                          ]
                    }
                  />
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
                invalid={submitted && !pollingValid}
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
