import { useRef, useState } from "react";
import { LoadingIndicator } from "@festo-ui/react";
import {
  IconCheckStatus,
  IconConnected,
  IconDownload,
  IconFailure,
  IconPlus,
  IconUpload,
} from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { configString, readMqttConfig, saveConnection } from "../storage";
import type { SavedConnection } from "../storage";
import { connectPlc, saveCurrentConfiguration } from "../configurationApi";
import { importDatablocks } from "./modbusDatablockImport";
import { downloadDatablockTemplate } from "./modbusDatablockTemplate";
import {
  MODBUS_DATABLOCK_DEFAULT_START_ADDRESS,
  MODBUS_DATABLOCK_REGISTER_COUNT,
} from "../../../shared/modbusDatablock.js";

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
  return (
    value.trim() !== "" &&
    Number.isInteger(parsed) &&
    parsed >= minimum &&
    parsed <= maximum
  );
}

function savedNumericValue(
  connection: SavedConnection | undefined,
  key: string,
  fallback: number,
) {
  const value = connection?.config?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : String(fallback);
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
    unitId: savedNumericValue(editConnection, "unitId", 1),
    timeout: savedNumericValue(editConnection, "timeout", 3000),
    polling: savedNumericValue(editConnection, "polling", 500),
    readMode: configString(editConnection, "readMode", "Read by Datablocks"),
    registerCount: savedNumericValue(editConnection, "registerCount", 1),
    startAddress: savedNumericValue(
      editConnection,
      "startAddress",
      MODBUS_DATABLOCK_DEFAULT_START_ADDRESS,
    ),
  });
  const [registers, setRegisters] = useState<ModbusRegister[]>(() => {
    const saved = editConnection?.config?.registers;
    const parsed = Array.isArray(saved) ? saved.filter(isModbusRegister) : [];
    return parsed.length > 0 ? parsed : [createRegister(0)];
  });
  const [blockTopics, setBlockTopics] = useState<string[]>(() => {
    const saved = editConnection?.config?.blockTopics;
    return Array.isArray(saved)
      ? saved.map((topic) => (typeof topic === "string" ? topic : ""))
      : [];
  });
  const byDatablocks = values.readMode === "Read by Datablocks";
  const countValid = isIntegerBetween(
    values.registerCount,
    1,
    Math.floor(65536 / MODBUS_DATABLOCK_REGISTER_COUNT),
  );
  const startAddressValid = isIntegerBetween(
    values.startAddress,
    0,
    65536 - MODBUS_DATABLOCK_REGISTER_COUNT,
  );
  const totalRegisters =
    Number(values.registerCount) * MODBUS_DATABLOCK_REGISTER_COUNT;
  const endAddress = Number(values.startAddress) + totalRegisters - 1;
  const blockRangeValid =
    countValid && startAddressValid && endAddress <= 65535;
  const activeBlockTopics = Array.from(
    { length: countValid ? Number(values.registerCount) : 0 },
    (_, index) => blockTopics[index] ?? "",
  );
  const topicsValid = activeBlockTopics.every(
    (topic) =>
      topic.trim() &&
      !/[+#\0]/.test(topic) &&
      new TextEncoder().encode(topic.trim()).length <= 65535,
  );
  const [submitted, setSubmitted] = useState(false);
  const [tested, setTested] = useState(false);
  const [testing, setTesting] = useState(false);
  const excelInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connectionStatus, setConnectionStatus] =
    useState<SavedConnection["status"]>("disconnected");

  const importExcel = async (file: File) => {
    if (importing || testing) return;
    setImporting(true);
    setImportError("");
    setTemplateError("");
    try {
      const imported = await importDatablocks(file);
      setValues((current) => ({
        ...current,
        startAddress: String(imported.startAddress),
        polling: String(imported.polling),
        registerCount: String(imported.blockTopics.length),
      }));
      setBlockTopics(imported.blockTopics);
      setTested(false);
      setSubmitted(false);
      setConnectionError("");
      setConnectionStatus("disconnected");
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Unable to import Excel file.",
      );
    } finally {
      setImporting(false);
    }
  };

  const set = (key: keyof typeof values) => (value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setTemplateError("");
  };
  const downloadTemplate = async () => {
    if (downloading) return;
    setTemplateError("");
    if (!countValid || !startAddressValid) {
      setTemplateError(
        "Enter a valid Number of Datablocks and Start address before downloading.",
      );
      return;
    }
    if (!isIntegerBetween(values.polling, 10, 3600000)) {
      setTemplateError(
        "Enter a polling interval from 10 to 3600000 ms before downloading.",
      );
      return;
    }
    setDownloading(true);
    try {
      await downloadDatablockTemplate({
        blockCount: Number(values.registerCount),
        startAddress: Number(values.startAddress),
        polling: Number(values.polling),
        blockTopics: activeBlockTopics,
      });
    } catch (error) {
      setTemplateError(
        error instanceof Error
          ? error.message
          : "Unable to download Excel template.",
      );
    } finally {
      setDownloading(false);
    }
  };
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
  const pollingValid = isIntegerBetween(values.polling, 10, 3600000);
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
    (byDatablocks
      ? blockRangeValid && topicsValid
      : registers.length > 0 && registersValid && registerNamesUnique),
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
    return {
      id: values.id,
      previousId: editConnection?.id,
      host: values.host,
      port: Number(values.port),
      unitId: Number(values.unitId),
      timeout: Number(values.timeout),
      polling: Number(values.polling),
      readMode: values.readMode,
      ...(byDatablocks
        ? {
            startAddress: Number(values.startAddress),
            registerCount: Number(values.registerCount),
            blockTopics: activeBlockTopics.map((topic) => topic.trim()),
          }
        : {
            registers: registers.map((register) => ({
              ...register,
              address: Number(register.address),
            })),
          }),
      mqtt: readMqttConfig(),
      mqttTopic: `festo/plc/${values.id}`,
    };
  };
  const connectToBackend = async () => {
    setTested(true);
    setConnectionError("");
    const result = await connectPlc(
      "/api/plcs/modbus/connect",
      buildBackendConfig(),
      "Unable to start Modbus polling",
    );
    setConnectionStatus(result.status);
    setConnectionError(result.connectionError ?? "");
    return result;
  };
  const save = async () => {
    setSubmitted(true);
    if (!valid) return;

    const result = await connectToBackend();
    saveConnection({
      recordId: editConnection?.recordId,
      id: values.id,
      protocol: "modbus.tcp",
      host: values.host,
      port: values.port,
      details: `unit-id: ${values.unitId}, timeout: ${values.timeout} ms, polling: ${values.polling} ms, ${byDatablocks ? `datablocks: ${values.registerCount}, start address: ${values.startAddress}, registers: ${totalRegisters}` : `registers: ${registers.map((register) => register.name).join(", ")}`}`,
      ...result,
      config: {
        ...values,
        registers,
        blockTopics: byDatablocks
          ? activeBlockTopics.map((topic) => topic.trim())
          : blockTopics,
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
            <fieldset
              className="fwe-modbus-form-fields"
              disabled={importing || saving}
            >
              <div className="fwe-form-title">
                <h1>
                  PLC Details - <span>Modbus TCP</span>
                </h1>
              </div>
              <div className="fwe-modbus-header-fields">
                <Field
                  label="Id"
                  value={values.id}
                  onChange={set("id")}
                  invalid={submitted && !values.id}
                  help="Please type in an Id for this PLC"
                />
                <SelectField
                  label="Reading method"
                  value={values.readMode}
                  onChange={(value) => {
                    set("readMode")(value);
                    setTested(false);
                    setSubmitted(false);
                    setImportError("");
                  }}
                  options={["Read by registers", "Read by Datablocks"]}
                />
              </div>
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
              <div className="fwe-data-heading fwe-modbus-data-heading">
                <h2>{values.readMode}</h2>
                {byDatablocks && (
                  <div className="fwe-modbus-excel-actions">
                    <input
                      ref={excelInput}
                      type="file"
                      accept=".xlsx"
                      hidden
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void importExcel(file);
                      }}
                    />
                    <button
                      type="button"
                      className="fwe-modbus-excel-import"
                      disabled={importing || testing || downloading}
                      onClick={() => excelInput.current?.click()}
                    >
                      <IconUpload svgProps={{ "aria-hidden": true }} />
                      {importing ? "Importing..." : "Import Excel"}
                    </button>
                    <button
                      type="button"
                      className="fwe-modbus-excel-template"
                      onClick={() => void downloadTemplate()}
                      disabled={downloading || importing}
                    >
                      <IconDownload svgProps={{ "aria-hidden": true }} />
                      {downloading ? "Downloading..." : "Download template"}
                    </button>
                  </div>
                )}
              </div>
              {byDatablocks ? (
                <div className="fwe-modbus-registers">
                  {templateError && (
                    <p className="fwe-modbus-range-error" role="alert">
                      {templateError}
                    </p>
                  )}
                  {importError && (
                    <p className="fwe-modbus-range-error" role="alert">
                      {importError}
                    </p>
                  )}
                  <div className="fwe-modbus-datablock-fields">
                    <Field
                      label="Number of Datablocks"
                      type="number"
                      value={values.registerCount}
                      onChange={set("registerCount")}
                      invalid={
                        (submitted || tested) &&
                        (!countValid || (startAddressValid && !blockRangeValid))
                      }
                    />
                    <Field
                      label="Start address"
                      type="number"
                      value={values.startAddress}
                      onChange={set("startAddress")}
                      invalid={(submitted || tested) && !startAddressValid}
                    />
                  </div>
                  {(submitted || tested) && !blockRangeValid && (
                    <p className="fwe-modbus-range-error" role="alert">
                      Enter a valid start address and block count. The last
                      register must not exceed 65535.
                    </p>
                  )}
                  {activeBlockTopics.map((topic, index) => (
                    <Field
                      key={index}
                      label={`FB ${index + 1} MQTT topic`}
                      value={topic}
                      onChange={(value) =>
                        setBlockTopics((current) => {
                          const next = [...current];
                          next[index] = value;
                          return next;
                        })
                      }
                      invalid={
                        (submitted || tested) &&
                        (!topic.trim() ||
                          /[+#\0]/.test(topic) ||
                          new TextEncoder().encode(topic.trim()).length > 65535)
                      }
                    />
                  ))}
                </div>
              ) : (
                <>
                  <p className="fwe-modbus-help">
                    Use the zero-based register address required by the Modbus
                    device.
                  </p>
                  <div className="fwe-modbus-registers">
                    {registers.map((register) => (
                      <div
                        className="fwe-modbus-register-row"
                        key={register.id}
                      >
                        <Field
                          label="Name"
                          value={register.name}
                          onChange={setRegister(register.id, "name")}
                          invalid={
                            submitted &&
                            (!register.name.trim() ||
                              registerNames.filter(
                                (name) =>
                                  name === register.name.trim().toLowerCase(),
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
                          Math.max(
                            ...current.map((register) => register.id),
                            -1,
                          ) + 1,
                        ),
                      ])
                    }
                  >
                    <IconPlus />
                    Add register
                  </button>
                </>
              )}
              <div className="fwe-modbus-polling">
                <Field
                  label="Polling interval"
                  value={values.polling}
                  onChange={set("polling")}
                  invalid={submitted && !pollingValid}
                  suffix="ms"
                />
              </div>
            </fieldset>
          </form>
        </section>
        <FormActions
          valid={valid}
          disabled={importing}
          onSave={async () => {
            setSaving(true);
            try {
              await save();
            } finally {
              setSaving(false);
            }
          }}
          onCancel={() => navigate(editConnection ? "/dashboard" : "/add")}
        />
      </div>
    </PlcShell>
  );
}
