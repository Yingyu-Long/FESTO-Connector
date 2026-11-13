import { buildCustomisedLayout, customisedInteger } from "./modbusCustomised.js";

export const MODBUS_LAYOUT_SHEET = "Datablock layout";
export const MODBUS_LAYOUT_HEADERS = Object.freeze(["Variable name", "Data type", "Width", "Unit"]);

export function createModbusLayoutRows(fields) {
  // New empty rows can be downloaded before their names have been entered.
  const usedNames = new Set(fields.map((field) => field.name.trim().toLowerCase()).filter(Boolean));
  const namedFields = fields.map((field, index) => {
    if (field.name.trim()) return field;
    let name = `field_${index + 1}`;
    while (usedNames.has(name.toLowerCase())) name += "_";
    usedNames.add(name.toLowerCase());
    return { ...field, name };
  });
  const configured = namedFields.filter((field) => field.dataType || field.bitWidth !== "");
  if (configured.length) buildCustomisedLayout(configured);
  return [
    [...MODBUS_LAYOUT_HEADERS],
    ...namedFields.map((field) => [
      field.name, field.dataType,
      field.bitWidth === "" ? "" : field.dataType === "STRING" ? Number(field.bitWidth) / 8 : Number(field.bitWidth),
      field.dataType ? field.dataType === "STRING" ? "bytes" : "bits" : "",
    ]),
  ];
}

export function parseModbusLayoutRows(rows) {
  for (const [index, header] of MODBUS_LAYOUT_HEADERS.entries()) {
    if (String(rows[0]?.[index] ?? "").trim() !== header) {
      throw new Error(`${String.fromCharCode(65 + index)}1: expected "${header}". Use the layout template.`);
    }
  }
  const fields = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index] ?? [];
    if (row.every((value) => value == null || (typeof value === "string" && !value.trim()))) continue;
    const [name, rawType, width, rawUnit] = row;
    if (typeof name !== "string" || !name.trim()) throw new Error(`A${index + 1}: enter a variable name as text.`);
    const dataType = typeof rawType === "string" ? rawType.trim().toUpperCase() : "";
    const unit = typeof rawUnit === "string" ? rawUnit.trim().toLowerCase() : "";
    if (unit !== "bits" && !(dataType === "STRING" && unit === "bytes")) {
      throw new Error(`D${index + 1}: use ${dataType === "STRING" ? '"bytes" or "bits"' : '"bits"'}.`);
    }
    const amount = customisedInteger(width, `C${index + 1} width`, 1, 65536 * 16);
    const field = { name: name.trim(), dataType, bitWidth: amount * (unit === "bytes" ? 8 : 1) };
    try { buildCustomisedLayout([field]); }
    catch (error) { throw new Error(`Row ${index + 1}: ${error.message}`, { cause: error }); }
    fields.push(field);
  }
  // Validate duplicates and the whole address range before replacing the editor.
  return buildCustomisedLayout(fields).fields.map(({ name, dataType, bitWidth }) => ({ name, dataType, bitWidth }));
}
