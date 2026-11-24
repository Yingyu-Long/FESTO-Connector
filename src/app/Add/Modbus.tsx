import { useRef, useState } from "react";
import type { SetStateAction } from "react";
import { LoadingIndicator } from "@festo-ui/react";
import { IconCheckStatus, IconFailure, IconConnected, IconDownload, IconPlus, IconUpload } from "@festo-ui/react-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { Field, FormActions, PlcShell, SelectField } from "./PlcShell";
import { readMqttConfig, readSavedConnections, saveConnection } from "../storage";
import type { SavedConnection } from "../storage";
import { connectPlc, saveCurrentConfiguration } from "../configurationApi";
import { importDatablocks } from "./modbusDatablockImport";
import { downloadDatablockTemplate } from "./modbusDatablockTemplate";
import { downloadLayoutTemplate, importLayoutTemplate } from "./modbusLayoutExcel";
import ModbusDatablockLayout from "./ModbusDatablockLayout";
import type { FieldRow } from "./ModbusDatablockLayout";
import { MODBUS_DATABLOCK_FIELDS, MODBUS_DATABLOCK_REGISTER_COUNT } from "../../../shared/modbusDatablock.js";
import { buildCustomisedLayout, CUSTOMISED_ENDPOINT, CUSTOMISED_PROTOCOL } from "../../../shared/modbusCustomised.js";

type Register = { id: number; name: string; registerType: string; address: string; dataType: string };
const createRegister = (id: number): Register => ({ id, name: "", registerType: "Holding register", address: "", dataType: "UInt16" });
const integer = (value: string, min: number, max: number) => value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;

export default function Modbus() {
  const location = useLocation();
  const navigate = useNavigate();
  const editing = (location.state as { connection?: SavedConnection } | null)?.connection;
  const oldCustom = editing?.protocol === CUSTOMISED_PROTOCOL;
  const saved = editing?.config ?? {};
  const [values, setValues] = useState(() => ({
    id: editing?.id ?? "", host: editing?.host ?? "", port: editing?.port ?? "502",
    unitId: String(saved.unitId ?? 1), timeout: String(saved.timeout ?? 3000), polling: String(saved.polling ?? 500),
    readMode: String(saved.readMode ?? "Read by Datablocks"), endian: String(saved.endian ?? "Big-Endian"),
    layoutMode: oldCustom || saved.layoutMode === "custom" || !editing ? "custom" : "standard",
    registerCount: String(oldCustom ? saved.blockCount ?? saved.registerCount ?? 1 : saved.registerCount ?? 1),
    startAddress: String(saved.startAddress ?? 0),
  }));
  const [fields, setFields] = useState<FieldRow[]>(() => {
    const source = Array.isArray(saved.fields) ? saved.fields : [{ name: "", dataType: "", bitWidth: "" }];
    return source.map((field) => ({ rowId: crypto.randomUUID(), name: String(field?.name ?? ""), dataType: String(field?.dataType ?? ""), bitWidth: String(field?.bitWidth ?? "") }));
  });
  const [registers, setRegisters] = useState<Register[]>(() => Array.isArray(saved.registers) && saved.registers.length
    ? saved.registers.map((r, i) => ({ id: i, name: String(r?.name ?? ""), registerType: String(r?.registerType ?? "Holding register"), address: String(r?.address ?? ""), dataType: String(r?.dataType ?? "UInt16") }))
    : [createRegister(0)]);
  const [topics, setTopics] = useState<string[]>(() => Array.isArray(saved.blockTopics) ? saved.blockTopics.map((topic) => String(topic ?? "")) : [""]);
  const [countValid, setCountValid] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<"" | "testing" | "saving" | "importing" | "downloading">("");
  const [notice, setNotice] = useState("");
  const [connected, setConnected] = useState(false);
  const layoutInput = useRef<HTMLInputElement>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [layoutExcelError, setLayoutExcelError] = useState("");
  const excelInput = useRef<HTMLInputElement>(null);
  const byDatablocks = values.readMode === "Read by Datablocks";
  const custom = byDatablocks && values.layoutMode === "custom";
  const resetResult = () => { setNotice(""); setConnected(false); };
  const set = (key: keyof typeof values) => (value: string) => { setValues((previous) => ({ ...previous, [key]: value })); if ((key === "layoutMode" || key === "readMode") && values[key] !== value) setCountValid(true); resetResult(); };
  const changeFields = (next: SetStateAction<FieldRow[]>) => { setFields(next); resetResult(); };
  let layout: ReturnType<typeof buildCustomisedLayout> | undefined;
  let layoutError = "";
  if (custom) {
    try { layout = buildCustomisedLayout(fields); }
    catch (error) { layoutError = (error as Error).message; }
  }
  const size = custom ? layout?.registerCount ?? 0 : MODBUS_DATABLOCK_REGISTER_COUNT;
  const blockCountValid = integer(values.registerCount, 1, Math.floor(65536 / Math.max(1, size)));
  const blockCount = blockCountValid ? Number(values.registerCount) : 0;
  const activeTopics = Array.from({ length: blockCount }, (_, index) => topics[index] ?? "");
  const totalRegisters = size * blockCount;
  const endAddress = Number(values.startAddress) + totalRegisters - 1;
  const rangeValid = size > 0 && blockCountValid && integer(values.startAddress, 0, 65535) && endAddress <= 65535;
  let validationError = "";
  if (!values.id.trim() || !values.host.trim()) validationError = "Enter a PLC Id and hostname or IP.";
  else if (!integer(values.port, 1, 65535)) validationError = "Port must be between 1 and 65535.";
  else if (!integer(values.unitId, 0, 255)) validationError = "Unit ID must be between 0 and 255.";
  else if (!integer(values.timeout, 100, 60000)) validationError = "Connection timeout must be between 100 and 60000 ms.";
  else if (!integer(values.polling, 10, 3600000)) validationError = "Polling interval must be between 10 and 3600000 ms.";
  else if (custom && (!countValid || layoutError)) validationError = layoutError || "Enter a valid number of fields.";
  else if (byDatablocks && !rangeValid) validationError = "Enter a valid block count and start address. The last register must not exceed 65535.";
  else if (byDatablocks && activeTopics.some((topic) => !topic.trim() || /[+#\0]/.test(topic) || new TextEncoder().encode(topic.trim()).length > 65535)) validationError = "Every datablock needs a valid MQTT topic (no +, # or null characters).";
  else if (!byDatablocks) {
    const names = registers.map((register) => register.name.trim().toLowerCase());
    if (!registers.length || registers.some((register) => !register.name.trim() || !integer(register.address, 0, ["Int32", "UInt32", "Float32"].includes(register.dataType) ? 65534 : 65535))) validationError = "Enter a name and valid address for every register.";
    else if (new Set(names).size !== names.length) validationError = "Register names must be unique.";
  }
  const backendConfig = () => ({
    id: values.id.trim(), previousId: oldCustom ? undefined : editing?.id, host: values.host.trim(),
    port: Number(values.port), unitId: Number(values.unitId), timeout: Number(values.timeout), polling: Number(values.polling),
    readMode: values.readMode,
    ...(byDatablocks ? {
      layoutMode: values.layoutMode, endian: values.endian, testMode: false,
      startAddress: Number(values.startAddress), registerCount: Number(values.registerCount),
      blockTopics: activeTopics.map((topic) => topic.trim()),
      ...(custom ? { fields: fields.map(({ name, dataType, bitWidth }) => ({ name: name.trim(), dataType, bitWidth: Number(bitWidth) })) } : {}),
    } : { registers: registers.map((register) => ({ ...register, name: register.name.trim(), address: Number(register.address) })) }),
    mqtt: readMqttConfig(), mqttTopic: `festo/plc/${values.id.trim()}`,
  });
  const testConnection = async () => {
    setSubmitted(true); resetResult();
    if (validationError || busy) return;
    setBusy("testing");
    try {
      const response = await fetch("/api/plcs/modbus/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(backendConfig()) });
      const result = await response.json();
      if (!response.ok || !result.connected) throw new Error(result.error || "Unable to read Modbus device.");
      setConnected(true); setNotice("Connected · Read successful");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to reach the PLC backend."); }
    finally { setBusy(""); }
  };
  const save = async () => {
    setSubmitted(true);
    if (validationError || busy) return;
    const conflict = readSavedConnections().find((connection) => connection.protocol === "modbus.tcp" && connection.id === values.id.trim() &&
      (editing?.recordId ? connection.recordId !== editing.recordId : oldCustom || editing?.id !== connection.id));
    if (conflict) throw new Error("This Modbus PLC Id already exists. Choose a different Id or edit that connection.");
    setBusy("saving");
    try {
      const config = backendConfig();
      const result = await connectPlc("/api/plcs/modbus/connect", config, "Unable to start Modbus polling.");
      // A successful migration can release its old subscription; the shared
      // socket stays alive for the new one. A failed migration keeps the old one.
      if (oldCustom) {
        if (result.status !== "connected") throw new Error(result.connectionError ?? "Unable to migrate this connection.");
        const response = await fetch(`${CUSTOMISED_ENDPOINT}/${encodeURIComponent(editing!.id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Unable to stop the previous customised subscription. Retry Save.");
      }
      saveConnection({ recordId: editing?.recordId, id: config.id, protocol: "modbus.tcp", host: config.host, port: String(config.port), ...result,
        details: byDatablocks ? `${custom ? "Custom layout" : "Standard FB"}: ${blockCount} datablocks · ${size} registers/block · ${values.polling} ms` : `${registers.length} registers · ${values.polling} ms`,
        config: { ...values, id: config.id, host: config.host, testMode: false, fields: fields.map(({ name, dataType, bitWidth }) => ({ name, dataType, bitWidth })), registers, blockTopics: (byDatablocks ? activeTopics : topics).map((topic) => topic.trim()) },
      });
      await saveCurrentConfiguration(); navigate("/dashboard");
    } finally { setBusy(""); }
  };
  const importExcel = async (file: File) => {
    if (busy) return;
    setBusy("importing"); resetResult();
    try {
      const imported = await importDatablocks(file, size);
      setValues((previous) => ({ ...previous, startAddress: String(imported.startAddress), polling: String(imported.polling), registerCount: String(imported.blockTopics.length) }));
      setTopics(imported.blockTopics); setSubmitted(false);
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(""); }
  };
  const downloadTemplate = async () => {
    if (busy) return;
    setBusy("downloading"); resetResult();
    try { await downloadDatablockTemplate({ blockCount, startAddress: Number(values.startAddress), polling: Number(values.polling), blockTopics: activeTopics, registersPerBlock: size }); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(""); }
  };
  const importLayoutExcel = async (file: File) => {
    if (busy) return;
    setLayoutExcelError(""); setBusy("importing");
    try {
      const imported = await importLayoutTemplate(file);
      changeFields(imported.map((field) => ({ ...field, rowId: crypto.randomUUID() })));
      setCountValid(true); setLayoutRevision((previous) => previous + 1);
    } catch (error) { setLayoutExcelError((error as Error).message); }
    finally { setBusy(""); }
  };
  const downloadLayoutExcel = async () => {
    if (busy) return;
    setLayoutExcelError("");
    if (!countValid) { setLayoutExcelError("Enter a valid number of fields before downloading."); return; }
    setBusy("downloading");
    try { await downloadLayoutTemplate(fields); }
    catch (error) { setLayoutExcelError((error as Error).message); }
    finally { setBusy(""); }
  };
  return <PlcShell>
    <div className="fwe-add-layout fwe-modbus-editor">
      <section className="fwe-siemens-card">
        <form onSubmit={(event) => event.preventDefault()}>
          <fieldset className="fwe-modbus-form-fields" disabled={Boolean(busy)}>
            <header className="fwe-modbus-page-title"><div><p>PLC CONNECTION</p><h1>Modbus TCP</h1></div></header>
            <section className="fwe-modbus-panel">
              <div className="fwe-modbus-section-title"><div><h2>Connection settings</h2></div></div>
              <div className="fwe-modbus-settings-grid">
                <Field label="PLC Id" value={values.id} onChange={set("id")} />
                <Field label="Hostname or IP" value={values.host} onChange={set("host")} />
                <Field label="Port" type="number" value={values.port} onChange={set("port")} />
                <SelectField label="Reading method" value={values.readMode} onChange={set("readMode")} options={["Read by Datablocks", "Read by registers"]} />
                <Field label="Unit ID" type="number" value={values.unitId} onChange={set("unitId")} />
                <Field label="Connection timeout" type="number" value={values.timeout} onChange={set("timeout")} suffix="ms" />
              </div>
              <div className="fwe-test-row">
                <button type="button" className="fwe-btn no-wrap" aria-label="Test connection" onClick={() => void testConnection()}><IconConnected />Test connection</button>
                {busy === "testing" && <LoadingIndicator size="small">Loading ...</LoadingIndicator>}
                {submitted && validationError && <div role="alert" className="fwe-connection-error"><IconFailure />{validationError}</div>}
                {notice && <span role="status" className={connected ? "fwe-status fwe-status-connected" : "fwe-status"}>{connected ? <IconCheckStatus aria-hidden="true" /> : <IconFailure aria-hidden="true" />}{notice}</span>}
              </div>
            </section>
            <section className="fwe-modbus-panel">
              <div className="fwe-modbus-section-title fwe-modbus-layout-heading">
                <h2>{byDatablocks ? "Datablock layout" : "Register configuration"}</h2>
                {custom && <div className="fwe-modbus-excel-actions">
                  <input ref={layoutInput} type="file" accept=".xlsx" hidden onChange={(event) => {
                    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
                    if (file) void importLayoutExcel(file);
                  }} />
                  <button type="button" className="fwe-modbus-excel-import" onClick={() => layoutInput.current?.click()}><IconUpload />Import Excel</button>
                  <button type="button" className="fwe-modbus-excel-template" onClick={() => void downloadLayoutExcel()}><IconDownload />Download template</button>
                </div>}
              </div>
              {custom && layoutExcelError && <p className="fwe-modbus-range-error" role="alert">{layoutExcelError}</p>}
              {byDatablocks ? <>
                <div className="fwe-modbus-layout-picker" role="group" aria-label="Datablock layout mode">
                  {[{ value: "custom", title: "Custom layout" }, { value: "standard", title: "Standard MIP function block" }].map((option) =>
                    <button type="button" key={option.value} aria-pressed={values.layoutMode === option.value} className={values.layoutMode === option.value ? "is-selected" : ""} onClick={() => set("layoutMode")(option.value)}><strong>{option.title}</strong></button>)}
                </div>
                {custom ? <ModbusDatablockLayout key={layoutRevision} fields={fields} setFields={changeFields} busy={Boolean(busy)} onCountValidityChange={setCountValid} /> :
                  <details className="fwe-modbus-standard-layout"><summary>View standard layout · 10 fields / 58 registers</summary><div className="fwe-customised-table-scroll"><table className="fwe-modbus-standard-table"><thead><tr><th>Variable name</th><th>Data type</th><th>Registers</th><th>Offset</th></tr></thead><tbody>{MODBUS_DATABLOCK_FIELDS.map((field) => <tr key={field.name}><td>{field.name}</td><td>{field.dataType}</td><td>{field.registerCount}</td><td>{field.offset}</td></tr>)}</tbody></table></div></details>}
              </> : <>
                <div className="fwe-modbus-registers">{registers.map((register, index) => {
                  const change = (key: keyof Register) => (value: string) => {
                    setRegisters((previous) => previous.map((row) => row.id === register.id ? { ...row, [key]: value, ...(key === "registerType" && ["Coil", "Discrete input"].includes(value) ? { dataType: "Boolean" } : {}) } : row)); resetResult();
                  };
                  return <div className="fwe-modbus-register-row" key={register.id}>
                    <Field label={`Name ${index + 1}`} value={register.name} onChange={change("name")} />
                    <SelectField label="Register type" value={register.registerType} onChange={change("registerType")} options={["Holding register", "Input register", "Coil", "Discrete input"]} />
                    <Field label="Address" value={register.address} onChange={change("address")} type="number" />
                    <SelectField label="Data type" value={register.dataType} onChange={change("dataType")} options={["Coil", "Discrete input"].includes(register.registerType) ? ["Boolean"] : ["Boolean", "Int16", "UInt16", "Int32", "UInt32", "Float32"]} />
                  </div>;
                })}</div>
                <button type="button" className="fwe-add-more" onClick={() => { setRegisters((previous) => [...previous, createRegister(Math.max(...previous.map((row) => row.id), -1) + 1)]); resetResult(); }}><IconPlus />Add register</button>
              </>}
            </section>
            <section className="fwe-modbus-mqtt-output">
              <div className="fwe-data-heading fwe-modbus-data-heading">
                <h2>MQTT output</h2>
                {byDatablocks && <div className="fwe-modbus-excel-actions">
                  <input hidden ref={excelInput} type="file" accept=".xlsx" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void importExcel(file); }} />
                  <button type="button" className="fwe-modbus-excel-import" onClick={() => excelInput.current?.click()}><IconUpload />Import Excel</button>
                  <button type="button" className="fwe-modbus-excel-template" onClick={() => void downloadTemplate()}><IconDownload />Download template</button>
                </div>}
              </div>
              {byDatablocks && <div className="fwe-modbus-settings-grid fwe-modbus-mqtt-settings">
                <Field label="Number of Datablocks" type="number" value={values.registerCount} onChange={set("registerCount")} />
                <Field label="Start address" type="number" value={values.startAddress} onChange={set("startAddress")} />
                <SelectField label="Word order" value={values.endian} onChange={set("endian")} options={["Big-Endian", "Little-Endian"]} />
              </div>}
              {byDatablocks ? <div className="fwe-modbus-registers">
                {activeTopics.map((topic, index) => <Field key={index} label={`FB ${index + 1} MQTT topic`} value={topic} onChange={(value) => { setTopics((previous) => { const next = [...previous]; next[index] = value; return next; }); resetResult(); }} />)}
              </div> : <label className="fwe-field"><span>MQTT topic</span><span className="fwe-input-wrap"><input readOnly value={`festo/plc/${values.id.trim()}`} /></span></label>}
              <div className="fwe-modbus-polling">
                <Field label="Polling interval" type="number" value={values.polling} onChange={set("polling")} suffix="ms" />
              </div>
            </section>
          </fieldset>
        </form>
      </section>
      <FormActions valid={!validationError} disabled={Boolean(busy)} onSave={save} onCancel={() => navigate(editing ? "/dashboard" : "/add")} />
    </div>
  </PlcShell>;
}
