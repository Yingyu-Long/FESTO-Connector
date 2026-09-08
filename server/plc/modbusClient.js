import ModbusRTU from "modbus-serial";

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

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ModbusConfigurationError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return parsed;
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
      100,
      3600000,
    ),
    registers,
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

export function decodeModbusRegisters(words, dataType, wordOrder) {
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

export async function readModbusRegister(client, register) {
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

export async function testModbusConnection(config) {
  const connection = await connectModbus(config);
  try {
    return await readModbusRegister(
      connection.client,
      connection.config.registers[0],
    );
  } finally {
    await disconnectModbus(connection.client);
  }
}
