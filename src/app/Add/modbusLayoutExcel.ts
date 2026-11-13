import type { CellObject, SheetData } from "write-excel-file/browser";
import type { CustomisedField } from "../../../shared/modbusCustomised.js";
import { createModbusLayoutRows, parseModbusLayoutRows, MODBUS_LAYOUT_SHEET } from "../../../shared/modbusLayoutTemplate.js";

export async function downloadLayoutTemplate(fields: CustomisedField[]) {
  const values = createModbusLayoutRows(fields);
  const rows: SheetData = values.map((row, index) => row.map((value): CellObject => ({
    value,
    type: typeof value === "number" ? Number : String,
    format: typeof value === "number" ? "0" : "@",
    height: index === 0 ? 28 : 23,
    alignVertical: "center",
    fontWeight: index === 0 ? "bold" : undefined,
    textColor: index === 0 ? "#FFFFFF" : "#263746",
    backgroundColor: index === 0 ? "#006EB6" : "#FFF2CC",
  })));
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  await writeXlsxFile(rows, {
    sheet: MODBUS_LAYOUT_SHEET,
    columns: [{ width: 36 }, { width: 18 }, { width: 14 }, { width: 14 }],
    showGridLines: false,
    stickyRowsCount: 1,
  }, { fontFamily: "Arial", fontSize: 11 }).toFile("modbus-custom-layout-template.xlsx");
}

export async function importLayoutTemplate(file: File): Promise<CustomisedField[]> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error("Choose an Excel .xlsx file.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose an Excel file smaller than 10 MB.");
  const { readSheet, SheetNotFoundError } = await import("read-excel-file/browser");
  let rows: unknown[][];
  try {
    rows = await readSheet(file, MODBUS_LAYOUT_SHEET, { trim: false });
  } catch (error) {
    if (error instanceof SheetNotFoundError) {
      throw new Error(`The workbook must contain a sheet named "${MODBUS_LAYOUT_SHEET}". Use the layout template.`, { cause: error });
    }
    throw new Error("Unable to read this workbook. Save it as an unencrypted .xlsx file and try again.", { cause: error });
  }
  return parseModbusLayoutRows(rows);
}
