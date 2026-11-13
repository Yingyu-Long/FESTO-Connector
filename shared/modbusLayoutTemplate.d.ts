import type { CustomisedField } from "./modbusCustomised.js";
export const MODBUS_LAYOUT_SHEET: "Datablock layout";
export const MODBUS_LAYOUT_HEADERS: readonly string[];
export function createModbusLayoutRows(fields: CustomisedField[]): (string | number)[][];
export function parseModbusLayoutRows(rows: unknown[][]): CustomisedField[];
