import { MODBUS_MAX_READ_REGISTERS } from "./modbusDatablock.js";

// Independent of the legacy 58-register FB layout. Offsets are in registers.
export const CUSTOMISED_PROTOCOL = "modbus.customised.tcp";
export const CUSTOMISED_ENDPOINT = "/api/plcs/modbus-customised";
export const CUSTOMISED_TYPES = Object.freeze({
  BOOL: 16, INT: 16, UINT: 16, DINT: 32, UDINT: 32,
  LINT: 64, ULINT: 64, REAL: 32, LREAL: 64, STRING: null,
});

export function customisedInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (
    !["string", "number"].includes(typeof value) ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isInteger(number) || number < minimum || number > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function buildCustomisedLayout(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error("Add at least one datablock field.");
  }
  const names = new Set();
  let offset = 0;
  const layout = fields.map((field, index) => {
    if (!field || typeof field !== "object") throw new Error(`Field ${index + 1} is invalid.`);
    const name = typeof field.name === "string" ? field.name.trim() : "";
    if (!name) throw new Error(`Field ${index + 1} needs a variable name.`);
    if (names.has(name.toLowerCase())) throw new Error(`Variable name ${name} is duplicated.`);
    names.add(name.toLowerCase());
    const dataType = field.dataType;
    if (typeof dataType !== "string" || !Object.hasOwn(CUSTOMISED_TYPES, dataType)) throw new Error(`${name}: unsupported data type.`);
    const bitWidth = customisedInteger(field.bitWidth, `${name} bit width`, 8, 65536 * 16);
    if (dataType === "STRING" ? bitWidth % 8 !== 0 : bitWidth !== CUSTOMISED_TYPES[dataType]) {
      throw new Error(dataType === "STRING"
        ? `${name}: STRING width must be a whole number of bytes.`
        : `${name}: ${dataType} requires ${CUSTOMISED_TYPES[dataType]} bits.`);
    }
    const registerCount = Math.ceil(bitWidth / 16);
    const result = { name, dataType, bitWidth, offset, registerCount };
    offset += registerCount;
    if (offset > MODBUS_MAX_READ_REGISTERS) {
      throw new Error(`A datablock cannot exceed ${MODBUS_MAX_READ_REGISTERS} registers; each block must fit in one read request.`);
    }
    return result;
  });
  return { fields: layout, registerCount: offset };
}

export function normaliseCustomisedConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Customised Modbus configuration is required.");
  const id = typeof config.id === "string" ? config.id.trim() : "";
  const host = typeof config.host === "string" ? config.host.trim() : "";
  if (!id || !host) throw new Error("PLC Id and hostname or IP are required.");
  const layout = buildCustomisedLayout(config.fields);
  const startAddress = customisedInteger(config.startAddress ?? 0, "Start address", 0, 65535);
  const blockCount = customisedInteger(config.blockCount, "Number of Datablocks", 1, 65536);
  if (startAddress + blockCount * layout.registerCount > 65536) {
    throw new Error("The last register must not exceed 65535.");
  }
  if (!Array.isArray(config.blockTopics) || config.blockTopics.length !== blockCount) {
    throw new Error("Every datablock needs an MQTT topic.");
  }
  const blockTopics = config.blockTopics.map((value, index) => {
    const topic = typeof value === "string" ? value.trim() : "";
    if (!topic || /[+#\0]/.test(topic) || new TextEncoder().encode(topic).length > 65535) {
      throw new Error(`Datablock ${index + 1} needs a valid MQTT topic (no +, # or null characters).`);
    }
    return topic;
  });
  const endian = config.endian ?? "Big-Endian";
  if (!["Big-Endian", "Little-Endian"].includes(endian)) throw new Error("Invalid word order.");
  return {
    ...config, id, host, fields: layout.fields, registersPerBlock: layout.registerCount,
    startAddress, blockCount, blockTopics, endian, readMode: "Read by Datablocks",
    port: customisedInteger(config.port ?? 502, "Port", 1, 65535),
    unitId: customisedInteger(config.unitId ?? 1, "Unit ID", 0, 255),
    timeout: customisedInteger(config.timeout ?? 3000, "Connection timeout", 100, 60000),
    polling: customisedInteger(config.polling ?? 500, "Polling interval", 10, 3600000),
  };
}

export function customisedExampleFields() {
  return [
    "timestamp_DI_IPos_ON", "timestamp_DI_IPos_OFF",
    "timestamp_DI_EPos_ON", "timestamp_DI_EPos_OFF",
    "timestamp_DO_MCtrl12_ON", "timestamp_DO_MCtrl12_OFF",
    "timestamp_DO_MCtrl14_ON", "timestamp_DO_MCtrl14_OFF",
  ].map((name) => ({ name, dataType: "ULINT", bitWidth: 64 })).concat([
    { name: "udiCycleCounter", dataType: "UDINT", bitWidth: 32 },
    { name: "sPartnumber", dataType: "STRING", bitWidth: 48 * 8 },
  ]);
}
