import { customisedInteger } from "../../shared/modbusCustomised.js";
import { MODBUS_MAX_READ_REGISTERS } from "../../shared/modbusDatablock.js";

export function decodeCustomisedDatablock(words, config) {
  if (!Array.isArray(words) || words.length !== config.registersPerBlock ||
      words.some((word) => !Number.isInteger(word) || word < 0 || word > 65535)) {
    throw new Error(`Datablock response must contain ${config.registersPerBlock} valid registers.`);
  }
  return Object.fromEntries(config.fields.map((field) => {
    const fieldWords = words.slice(field.offset, field.offset + field.registerCount);
    if (config.endian === "Little-Endian") fieldWords.reverse();
    const buffer = Buffer.alloc(field.registerCount * 2);
    fieldWords.forEach((word, index) => buffer.writeUInt16BE(word, index * 2));
    let value;
    switch (field.dataType) {
      case "BOOL": value = buffer.readUInt16BE() !== 0; break;
      case "INT": value = buffer.readInt16BE(); break;
      case "UINT": value = buffer.readUInt16BE(); break;
      case "DINT": value = buffer.readInt32BE(); break;
      case "UDINT": value = buffer.readUInt32BE(); break;
      // JSON has no lossless 64-bit integer number type. Preserve all bits.
      case "LINT": value = buffer.readBigInt64BE().toString(); break;
      case "ULINT": value = buffer.readBigUInt64BE().toString(); break;
      case "REAL": value = buffer.readFloatBE(); break;
      case "LREAL": value = buffer.readDoubleBE(); break;
      case "STRING": {
        const bytes = buffer.subarray(0, field.bitWidth / 8);
        const end = bytes.indexOf(0);
        value = bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
        break;
      }
      default: throw new Error(`Unsupported data type: ${field.dataType}`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${field.name} contains a non-finite floating point value.`);
    }
    return [field.name, value];
  }));
}

export async function readCustomisedDatablocks(client, config) {
  const dataBlocks = [];
  const registersPerBlock = customisedInteger(config.registersPerBlock,
    "Registers per datablock", 1, MODBUS_MAX_READ_REGISTERS);
  // Read only whole blocks. Spare capacity in a response is left unused,
  // so no datablock (or field within it) spans multiple FC03 requests.
  const blocksPerBatch = Math.floor(MODBUS_MAX_READ_REGISTERS / registersPerBlock);
  for (let index = 0; index < config.blockCount; index += blocksPerBatch) {
    const count = Math.min(blocksPerBatch, config.blockCount - index);
    const startAddress = config.startAddress + index * registersPerBlock;
    const total = count * registersPerBlock;
    const response = await client.readHoldingRegisters(startAddress, total);
    if (!Array.isArray(response.data) || response.data.length !== total) {
      throw new Error(`Datablock response must contain ${total} registers.`);
    }
    for (let block = 0; block < count; block++) {
      const offset = block * registersPerBlock;
      dataBlocks.push({
        index: index + block,
        startAddress: startAddress + offset,
        registerCount: registersPerBlock,
        topic: config.blockTopics[index + block],
        values: decodeCustomisedDatablock(response.data.slice(offset, offset + registersPerBlock), config),
      });
    }
  }
  return dataBlocks;
}

