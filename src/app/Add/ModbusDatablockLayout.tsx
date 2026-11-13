import { useRef, useState } from "react";
import { IconPlus } from "@festo-ui/react-icons";
import type { Dispatch, SetStateAction } from "react";
import { CUSTOMISED_TYPES, buildCustomisedLayout } from "../../../shared/modbusCustomised.js";
import { MODBUS_MAX_READ_REGISTERS } from "../../../shared/modbusDatablock.js";
import type { CustomisedField } from "../../../shared/modbusCustomised.js";

export type FieldRow = CustomisedField & { rowId: string };
const withRowId = (field: CustomisedField): FieldRow => ({ ...field, rowId: crypto.randomUUID() });
const numericTypeFamilies = [
  ["INT", "DINT", "LINT"],
  ["UINT", "UDINT", "ULINT"],
  ["REAL", "LREAL"],
  ["BOOL"],
];

function widthTypes(dataType: string) {
  return numericTypeFamilies.find((family) => family.includes(dataType)) ?? [dataType];
}

export default function ModbusDatablockLayout({ fields, setFields, busy, onCountValidityChange }: {
  fields: FieldRow[];
  setFields: Dispatch<SetStateAction<FieldRow[]>>;
  busy: boolean;
  onCountValidityChange: (valid: boolean) => void;
}) {
  const [fieldCountDraft, setFieldCountDraft] = useState<string | null>(null);
  const fieldCountEditRows = useRef<FieldRow[] | null>(null);
  const [draggedRowId, setDraggedRowId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ rowId: string; after: boolean } | null>(null);
  let layout: ReturnType<typeof buildCustomisedLayout> | undefined;
  let layoutError = "";
  try { layout = buildCustomisedLayout(fields); }
  catch (error) { layoutError = (error as Error).message; }
  const fieldCountValue = fieldCountDraft ?? String(fields.length);
  const fieldCountValid = fieldCountValue.trim() !== "" &&
    Number.isInteger(Number(fieldCountValue)) && Number(fieldCountValue) >= 1 && Number(fieldCountValue) <= MODBUS_MAX_READ_REGISTERS;
  const resizeFields = (value: string) => {
    setFieldCountDraft(value);
    onCountValidityChange(value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= MODBUS_MAX_READ_REGISTERS);
    const count = Number(value);
    if (value.trim() && Number.isInteger(count) && count >= 1 && count <= MODBUS_MAX_READ_REGISTERS) {
      // Keep the input session's rows while typing, e.g. 10 -> 1 -> 12.
      const originalRows = fieldCountEditRows.current;
      setFields((previous) => Array.from({ length: count }, (_, index) =>
        previous[index] ?? originalRows?.[index] ?? withRowId({ name: "", dataType: "", bitWidth: "" }),
      ));
    }

  };
  const updateField = (rowId: string, changes: Partial<CustomisedField>) => {
    setFields((previous) => previous.map((field) => field.rowId === rowId ? { ...field, ...changes } : field));

  };
  const moveField = (sourceId: string, targetId: string, after: boolean) => {
    if (sourceId === targetId) return;
    setFields((previous) => {
      const source = previous.find((field) => field.rowId === sourceId);
      if (!source || !previous.some((field) => field.rowId === targetId)) return previous;
      const next = previous.filter((field) => field.rowId !== sourceId);
      const targetIndex = next.findIndex((field) => field.rowId === targetId);
      next.splice(targetIndex + (after ? 1 : 0), 0, source);
      return next;
    });

  };
  const clearDrag = () => { setDraggedRowId(null); setDropTarget(null); };
  return <div className="fwe-modbus-layout-editor">
              <div className="fwe-customised-toolbar">
                <label className="fwe-field fwe-customised-field-count">
                  <span>Fields *</span>
                  <span className="fwe-input-wrap"><input type="number" min="1" max={MODBUS_MAX_READ_REGISTERS} step="1"
                    value={fieldCountValue} aria-invalid={!fieldCountValid}
                    onFocus={() => { fieldCountEditRows.current = fields; }}
                    onChange={(event) => resizeFields(event.target.value)}
                    onBlur={() => {
                      fieldCountEditRows.current = null;
                      if (fieldCountValid) setFieldCountDraft(null);
                    }} /></span>
                </label>
                <div className="fwe-modbus-layout-total"><strong>{layout?.registerCount ?? "—"}</strong><span>registers per block</span></div>
              </div>
              {!fieldCountValid && <p className="fwe-connection-error" role="alert">Fields must be a whole number from 1 to {MODBUS_MAX_READ_REGISTERS}.</p>}
              <div className="fwe-customised-table-scroll">
                <table className="fwe-customised-table">
                  <thead><tr><th aria-label="Drag to reorder" /><th>Variable name / MQTT key</th><th>Data type</th><th>Width</th><th>Registers</th><th>Offset</th><th>Remove</th></tr></thead>
                  <tbody>{fields.map((field, index) => (
                    <tr key={field.rowId}
                      className={`${draggedRowId === field.rowId ? "fwe-customised-dragging" : ""} ${dropTarget?.rowId === field.rowId && draggedRowId !== field.rowId ? `fwe-customised-drop-${dropTarget.after ? "after" : "before"}` : ""}`}
                      onDragOver={(event) => {
                        if (!draggedRowId || busy) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        const bounds = event.currentTarget.getBoundingClientRect();
                        setDropTarget({ rowId: field.rowId, after: event.clientY > bounds.top + bounds.height / 2 });
                      }}
                      onDrop={(event) => {
                        if (!draggedRowId || busy) return;
                        event.preventDefault();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        moveField(draggedRowId, field.rowId, event.clientY > bounds.top + bounds.height / 2);
                        clearDrag();
                      }}>
                      <td><button type="button" className="fwe-customised-drag-handle" draggable={!busy}
                        aria-label={`Drag field ${index + 1} to reorder`} title="Drag to reorder"
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", field.rowId);
                          const row = event.currentTarget.closest("tr");
                          if (row) event.dataTransfer.setDragImage(row, 20, row.offsetHeight / 2);
                          setDraggedRowId(field.rowId);
                        }}
                        onDragEnd={clearDrag}
                        onKeyDown={(event) => {
                          const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                          if (!direction) return;
                          event.preventDefault();
                          const target = fields[index + direction];
                          if (target) moveField(field.rowId, target.rowId, direction > 0);
                        }}><span aria-hidden="true">⠿</span></button></td>
                      <td><input aria-label={`Variable name ${index + 1}`} value={field.name} onChange={(e) => updateField(field.rowId, { name: e.target.value })} /></td>
                      <td><select aria-label={`Data type ${index + 1}`} value={field.dataType} onChange={(e) => updateField(field.rowId, {
                        dataType: e.target.value, bitWidth: CUSTOMISED_TYPES[e.target.value] ?? "",
                      })}><option value="" disabled>Select type</option>{Object.keys(CUSTOMISED_TYPES).map((type) => <option key={type}>{type}</option>)}</select></td>
                      <td><div className="fwe-customised-width">{field.dataType === "STRING" ? (
                        <input type="number" min="1" max={MODBUS_MAX_READ_REGISTERS * 2} step="1" aria-label={`Width ${index + 1}`}
                          value={field.bitWidth === "" ? "" : Number(field.bitWidth) / 8}
                          onChange={(e) => updateField(field.rowId, { bitWidth: e.target.value === "" ? "" : Number(e.target.value) * 8 })} />
                      ) : (
                        <select aria-label={`Width ${index + 1}`} value={field.dataType} disabled={!field.dataType}
                          onChange={(event) => updateField(field.rowId, {
                            dataType: event.target.value, bitWidth: CUSTOMISED_TYPES[event.target.value]!,
                          })}>
                          {!field.dataType && <option value="">—</option>}
                          {field.dataType && widthTypes(field.dataType).map((type) => <option key={type} value={type}>{CUSTOMISED_TYPES[type]}</option>)}
                        </select>
                      )}
                        <span>{field.dataType ? field.dataType === "STRING" ? "bytes" : "bits" : ""}</span></div></td>
                      <td><span className="fwe-modbus-register-badge">{layout?.fields[index]?.registerCount ?? "—"}</span></td>
                      <td className="fwe-modbus-offset">{layout?.fields[index]?.offset ?? "—"}</td>
                      <td><div className="fwe-customised-row-actions">
                        <button type="button" disabled={fields.length === 1} aria-label={`Remove field ${index + 1}`} onClick={() => { setFields((previous) => previous.filter((row) => row.rowId !== field.rowId)); setFieldCountDraft(null); onCountValidityChange(true); }}>×</button>
                      </div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="fwe-customised-toolbar">
                <button type="button" className="fwe-btn no-wrap fwe-modbus-action-button" disabled={fields.length >= MODBUS_MAX_READ_REGISTERS} onClick={() => { setFields((previous) => [...previous, withRowId({ name: "", dataType: "", bitWidth: "" })]); setFieldCountDraft(null); onCountValidityChange(true); }}><IconPlus />Add field</button>
              </div>
              {layoutError && fields.some((field) => field.name || field.dataType || field.bitWidth) && <p className="fwe-connection-error" role="alert">{layoutError}</p>}
  </div>;
}
