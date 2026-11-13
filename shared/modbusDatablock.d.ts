export const MODBUS_MAX_READ_REGISTERS: 125;
export const MODBUS_DATABLOCK_REGISTER_COUNT: 58;
export const MODBUS_DATABLOCK_DEFAULT_START_ADDRESS: 0;
export const MODBUS_DATABLOCK_FIELDS: readonly Readonly<{
  name: string;
  dataType: "ULINT" | "UDINT" | "STRING[48]";
  offset: number;
  registerCount: number;
}>[];
