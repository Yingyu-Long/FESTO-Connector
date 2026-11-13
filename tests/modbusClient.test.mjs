import assert from "node:assert/strict";
import test from "node:test";
import {
  ModbusConfigurationError,
  normalizeModbusConfig,
  readModbusDatablocks,
  readModbusSample,
} from "../server/plc/modbusClient.js";

const baseConfig = {
  id: "test-plc",
  host: "plc",
  readMode: "Read by Datablocks",
  startAddress: 100,
  registerCount: 3,
  blockTopics: ["fb/1", "fb/2", "fb/3"],
};
const timestampNames = [
  "timestamp_DI_IPos_ON", "timestamp_DI_IPos_OFF",
  "timestamp_DI_EPos_ON", "timestamp_DI_EPos_OFF",
  "timestamp_DO_MCtrl12_ON", "timestamp_DO_MCtrl12_OFF",
  "timestamp_DO_MCtrl14_ON", "timestamp_DO_MCtrl14_OFF",
];

test("datablock test mode defaults off and accepts only booleans", () => {
  assert.equal(normalizeModbusConfig(baseConfig).testMode, false);
  for (const testMode of [true, false]) {
    assert.equal(normalizeModbusConfig({ ...baseConfig, testMode }).testMode, testMode);
  }
  for (const testMode of ["false", "true", 0, 1, null]) {
    assert.throws(
      () => normalizeModbusConfig({ ...baseConfig, testMode }),
      ModbusConfigurationError,
    );
  }
});

test("datablock endian defaults to big endian and rejects unsupported values", () => {
  assert.equal(normalizeModbusConfig(baseConfig).endian, "Big-Endian");
  assert.equal(
    normalizeModbusConfig({ ...baseConfig, endian: "Little-Endian" }).endian,
    "Little-Endian",
  );
  assert.throws(
    () => normalizeModbusConfig({ ...baseConfig, endian: "invalid" }),
    ModbusConfigurationError,
  );
});

for (const endian of [undefined, "Big-Endian", "Little-Endian"]) {
  test(`${endian ?? "legacy default"} decodes each variable independently across batches`, async () => {
    const little = endian === "Little-Endian";
    const expected = [];
    const words = [];
    for (let block = 0; block < 3; block++) {
      const values = {};
      for (const [index, name] of timestampNames.entries()) {
        const lowWord = 0x7700 + block * 16 + index;
        // Distinct bytes detect accidental byte swapping as well as word order.
        words.push(...(little
          ? [lowWord, 0x5566, 0x3344, 0xf122]
          : [0xf122, 0x3344, 0x5566, lowWord]));
        values[name] = (0xf122334455660000n + BigInt(lowWord)).toString();
      }
      words.push(...(little ? [0x3344, 0x1122] : [0x1122, 0x3344]));
      values.cycle_counter = 0x11223344;
      // Reverse the whole STRING[48] field, including null padding.
      words.push(...(little
        ? [...Array(22).fill(0), 0x4344, 0x4142]
        : [0x4142, 0x4344, ...Array(22).fill(0)]));
      values.part_number = "ABCD";
      expected.push({
        index: block,
        startAddress: 100 + block * 58,
        registerCount: 58,
        topic: `fb/${block + 1}`,
        values,
      });
    }
    const originalWords = [...words];
    const calls = [];
    const client = {
      async readHoldingRegisters(address, count) {
        calls.push([address, count]);
        return { data: words.slice(address - 100, address - 100 + count) };
      },
    };
    const config = normalizeModbusConfig({ ...baseConfig, endian });
    assert.deepEqual(await readModbusDatablocks(client, config), expected);
    assert.deepEqual(calls, [[100, 116], [216, 58]]);
    assert.deepEqual(await readModbusSample(client, config), expected);
    assert.deepEqual(words, originalWords);
  });
}
