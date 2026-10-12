import ModbusRTU from "modbus-serial";
import {
  MODBUS_DATABLOCK_DEFAULT_START_ADDRESS,
  MODBUS_DATABLOCK_FIELDS,
  MODBUS_DATABLOCK_REGISTER_COUNT,
} from "../../shared/modbusDatablock.js";

// FC03 allows up to 125 registers per request; keep each FB in one response.
const DATABLOCKS_PER_REQUEST = Math.floor(125 / MODBUS_DATABLOCK_REGISTER_COUNT);

const REGISTER_TYPES = new Set([
  "Coil",
  "Discrete input",
  "Input register",
  "Holding register",
]);
const DATA_TYPES = new Set([
  "Boolean",
  "Int16",
  "UInt16",
  "Int32",
  "UInt32",
  "Float32",
]);

export class ModbusConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModbusConfigurationError";
  }
}

export function modbusErrorMessage(error) {
  // modbus-serial also rejects with objects that do not extend Error.
  return typeof error?.message === "string" ? error.message : String(error);
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (
    !["number", "string"].includes(typeof value) ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new ModbusConfigurationError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
}

function normalizeDatablocks(config) {
  const startAddress = integer(
    config.startAddress === undefined
      ? MODBUS_DATABLOCK_DEFAULT_START_ADDRESS
      : config.startAddress,
    "Datablock start address",
    0,
    65535,
  );
  const maximumBlocks = Math.floor(
    (65536 - startAddress) / MODBUS_DATABLOCK_REGISTER_COUNT,
  );
  if (maximumBlocks === 0) {
    throw new ModbusConfigurationError(
      "Datablock exceeds the Modbus address range",
    );
  }
  const registerCount = integer(
    config.registerCount,
    "Datablock count",
    1,
    maximumBlocks,
  );
  if (
    !Array.isArray(config.blockTopics) ||
    config.blockTopics.length !== registerCount
  ) {
    throw new ModbusConfigurationError(
      "Every Datablock needs an MQTT topic",
    );
  }
  const blockTopics = config.blockTopics.map((value, index) => {
    const topic = typeof value === "string" ? value.trim() : "";
    if (
      !topic ||
      /[+#]/.test(topic) ||
      topic.includes("\0") ||
      Buffer.byteLength(topic, "utf8") > 65535
    ) {
      throw new ModbusConfigurationError(
        `Datablock ${index + 1} needs a valid MQTT publish topic (no +, # or null characters)`,
      );
    }
    return topic;
  });
  return { startAddress, registerCount, blockTopics, registers: [] };
}

function registerLength(dataType) {
  return ["Int32", "UInt32", "Float32"].includes(dataType) ? 2 : 1;
}

function normalizeRegister(register, index) {
  if (!register || typeof register !== "object") {
    throw new ModbusConfigurationError(`Register ${index + 1} is invalid`);
  }

  const name = String(register.name ?? "").trim();
  const registerType = String(register.registerType ?? "");
  const dataType = String(register.dataType ?? "");
  if (!name) {
    throw new ModbusConfigurationError(`Register ${index + 1} needs a name`);
  }
  if (!REGISTER_TYPES.has(registerType)) {
    throw new ModbusConfigurationError(
      `Register ${name} has an unsupported register type`,
    );
  }
  if (!DATA_TYPES.has(dataType)) {
    throw new ModbusConfigurationError(
      `Register ${name} has an unsupported data type`,
    );
  }
  if (
    ["Coil", "Discrete input"].includes(registerType) &&
    dataType !== "Boolean"
  ) {
    throw new ModbusConfigurationError(
      `Register ${name} must use Boolean for a bit-based register type`,
    );
  }

  const address = integer(
    register.address,
    `Register ${name} address`,
    0,
    65535,
  );
  const length = registerLength(dataType);
  if (address + length > 65536) {
    throw new ModbusConfigurationError(
      `Register ${name} exceeds the Modbus address range`,
    );
  }

  return {
    ...register,
    id: Number(register.id ?? index),
    name,
    registerType,
    address,
    dataType,
    length,
    wordOrder:
      register.wordOrder === "Low word first"
        ? "Low word first"
        : "High word first",
  };
}

export function normalizeModbusConfig(config) {
  if (!config || typeof config !== "object") {
    throw new ModbusConfigurationError("Modbus configuration is required");
  }

  const id = String(config.id ?? "").trim();
  const host = String(config.host ?? "").trim();
  if (!id) throw new ModbusConfigurationError("Modbus PLC id is required");
  if (!host) throw new ModbusConfigurationError("Modbus host is required");
  let readingConfig;
  if (config.readMode === "Read by Datablocks") {
    readingConfig = normalizeDatablocks(config);
  } else {
    if (!Array.isArray(config.registers) || config.registers.length === 0) {
      throw new ModbusConfigurationError(
        "At least one Modbus register is required",
      );
    }
    const registers = config.registers.map(normalizeRegister);
    const names = new Set();
    for (const register of registers) {
      const key = register.name.toLowerCase();
      if (names.has(key)) {
        throw new ModbusConfigurationError(
          `Register name ${register.name} is duplicated`,
        );
      }
      names.add(key);
    }
    readingConfig = { registers };
  }

  return {
    ...config,
    id,
    host,
    port: integer(config.port ?? 502, "Modbus port", 1, 65535),
    unitId: integer(config.unitId ?? 1, "Modbus Unit ID", 0, 255),
    timeout: integer(config.timeout ?? 3000, "Modbus timeout", 100, 60000),
    polling: integer(
      config.polling ?? 500,
      "Modbus polling interval",
      10,
      3600000,
    ),
    ...readingConfig,
  };
}

export async function connectModbus(config) {
  const normalized = normalizeModbusConfig(config);
  const client = new ModbusRTU();
  client.setTimeout(normalized.timeout);

  try {
    await client.connectTCP(normalized.host, { port: normalized.port });
    client.setID(normalized.unitId);
    return { client, config: normalized };
  } catch (error) {
    await disconnectModbus(client);
    throw error;
  }
}

export async function disconnectModbus(client) {
  if (!client) return;

  await new Promise((resolve) => {
    let settled = false;
    let forceCloseTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      resolve();
    };

    try {
      if (!client.isOpen) {
        client.destroy(() => undefined);
        finish();
        return;
      }

      forceCloseTimer = setTimeout(() => {
        try {
          client.destroy(finish);
        } catch {
          finish();
        }
      }, 500);
      client.close(finish);
    } catch {
      finish();
    }
  });
}

function decodeModbusRegisters(words, dataType, wordOrder) {
  const orderedWords =
    wordOrder === "Low word first" && words.length === 2
      ? [words[1], words[0]]
      : words;
  const buffer = Buffer.alloc(orderedWords.length * 2);
  orderedWords.forEach((word, index) => {
    buffer.writeUInt16BE(Number(word) & 0xffff, index * 2);
  });

  switch (dataType) {
    case "Boolean":
      return orderedWords[0] !== 0;
    case "Int16":
      return buffer.readInt16BE(0);
    case "UInt16":
      return buffer.readUInt16BE(0);
    case "Int32":
      return buffer.readInt32BE(0);
    case "UInt32":
      return buffer.readUInt32BE(0);
    case "Float32":
      return buffer.readFloatBE(0);
    default:
      throw new ModbusConfigurationError(
        `Unsupported Modbus data type: ${dataType}`,
      );
  }
}

async function readModbusRegister(client, register) {
  let response;
  switch (register.registerType) {
    case "Coil":
      response = await client.readCoils(register.address, 1);
      break;
    case "Discrete input":
      response = await client.readDiscreteInputs(register.address, 1);
      break;
    case "Input register":
      response = await client.readInputRegisters(
        register.address,
        register.length,
      );
      break;
    case "Holding register":
      response = await client.readHoldingRegisters(
        register.address,
        register.length,
      );
      break;
    default:
      throw new ModbusConfigurationError(
        `Unsupported register type: ${register.registerType}`,
      );
  }

  const value = ["Coil", "Discrete input"].includes(register.registerType)
    ? Boolean(response.data[0])
    : decodeModbusRegisters(
        response.data,
        register.dataType,
        register.wordOrder,
      );

  return {
    name: register.name,
    registerType: register.registerType,
    address: register.address,
    dataType: register.dataType,
    value,
  };
}

export async function readModbusRegisters(client, registers) {
  const values = [];
  for (const register of registers) {
    values.push(await readModbusRegister(client, register));
  }
  return values;
}

function decodeModbusDatablock(words) {
  if (
    !Array.isArray(words) ||
    words.length !== MODBUS_DATABLOCK_REGISTER_COUNT ||
    words.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)
  ) {
    throw new Error(
      `Datablock response must contain ${MODBUS_DATABLOCK_REGISTER_COUNT} valid registers`,
    );
  }
  const buffer = Buffer.alloc(MODBUS_DATABLOCK_REGISTER_COUNT * 2);
  words.forEach((word, index) => buffer.writeUInt16BE(word, index * 2));
  return Object.fromEntries(
    MODBUS_DATABLOCK_FIELDS.map((field) => {
      const offset = field.offset * 2;
      let value;
      if (field.dataType === "ULINT") {
        // Decimal strings retain all 64 bits when serialized as JSON.
        value = buffer.readBigUInt64BE(offset).toString();
      } else if (field.dataType === "UDINT") {
        value = buffer.readUInt32BE(offset);
      } else {
        // The PLC layout specifies 48 string bytes, without a length header.
        const bytes = buffer.subarray(offset, offset + field.registerCount * 2);
        const end = bytes.indexOf(0);
        value = bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
      }
      return [field.name, value];
    }),
  );
}

export async function readModbusDatablocks(client, config) {
  const dataBlocks = [];
  for (
    let index = 0;
    index < config.registerCount;
    index += DATABLOCKS_PER_REQUEST
  ) {
    const blockCount = Math.min(
      DATABLOCKS_PER_REQUEST,
      config.registerCount - index,
    );
    const startAddress =
      config.startAddress + index * MODBUS_DATABLOCK_REGISTER_COUNT;
    const registerCount = blockCount * MODBUS_DATABLOCK_REGISTER_COUNT;
    const response = await client.readHoldingRegisters(
      startAddress,
      registerCount,
    );
    if (!Array.isArray(response.data) || response.data.length !== registerCount) {
      throw new Error(
        `Datablock batch response must contain ${registerCount} registers`,
      );
    }
    for (let offset = 0; offset < blockCount; offset += 1) {
      const registerOffset = offset * MODBUS_DATABLOCK_REGISTER_COUNT;
      const values = decodeModbusDatablock(
        response.data.slice(
          registerOffset,
          registerOffset + MODBUS_DATABLOCK_REGISTER_COUNT,
        ),
      );
      const blockIndex = index + offset;
      dataBlocks.push({
        index: blockIndex,
        startAddress: startAddress + registerOffset,
        registerCount: MODBUS_DATABLOCK_REGISTER_COUNT,
        topic: config.blockTopics[blockIndex],
        values,
      });
    }
  }
  return dataBlocks;
}

export async function readModbusSample(client, config) {
  if (config.readMode === "Read by Datablocks") {
    return await readModbusDatablocks(client, config);
  }
  return await readModbusRegister(client, config.registers[0]);
}

export async function testModbusConnection(config) {
  const connection = await connectModbus(config);
  try {
    return await readModbusSample(connection.client, connection.config);
  } finally {
    await disconnectModbus(connection.client);
  }
}
