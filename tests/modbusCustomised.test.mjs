import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCustomisedLayout, customisedExampleFields, normaliseCustomisedConfig,
} from "../shared/modbusCustomised.js";
import { decodeCustomisedDatablock, readCustomisedDatablocks } from "../server/plc/modbusCustomisedReader.js";
import { normalizeModbusConfig, readModbusSample, ModbusConfigurationError } from "../server/plc/modbusClient.js";

const base = {
  id: "custom-test", host: "plc", startAddress: 100, blockCount: 1,
  fields: customisedExampleFields(), blockTopics: ["custom/fb/1"],
};
const field = (name, dataType, bitWidth) => ({ name, dataType, bitWidth });

test("image example totals 58 registers while preserving the user's MQTT field names", () => {
  const layout = buildCustomisedLayout(customisedExampleFields());
  assert.equal(layout.registerCount, 58);
  assert.deepEqual(layout.fields.map((f) => f.offset), [0, 4, 8, 12, 16, 20, 24, 28, 32, 34]);
  const result = decodeCustomisedDatablock(Array(58).fill(0), normaliseCustomisedConfig(base));
  assert.deepEqual(Object.keys(result), customisedExampleFields().map((f) => f.name));
  assert.equal(result.udiCycleCounter, 0);
  assert.equal(result.sPartnumber, "");
  assert.ok(!Object.hasOwn(result, "isThisAutomaticMode"));
});

for (const endian of ["Big-Endian", "Little-Endian"]) {
  test(`${endian}: decodes configured integer, float, boolean and string fields without precision loss`, () => {
    const fields = [field("signed", "INT", 16), field("unsigned", "UINT", 16),
      field("counter", "UDINT", 32), field("negative", "DINT", 32),
      field("maximum", "ULINT", 64), field("minimum", "LINT", 64),
      field("temperature", "REAL", 32), field("measurement", "LREAL", 64),
      field("running", "BOOL", 16), field("name", "STRING", 24)];
    const config = normaliseCustomisedConfig({ ...base, fields, endian });
    assert.equal(config.registersPerBlock, 23);
    const bytes = [Buffer.from("fffe", "hex"), Buffer.from("ffff", "hex"),
      Buffer.from("ffffffff", "hex"), Buffer.from("80000000", "hex"),
      Buffer.from("ffffffffffffffff", "hex"), Buffer.from("8000000000000000", "hex"),
      Buffer.from("41480000", "hex"), Buffer.from("400921fb54442d18", "hex"),
      Buffer.from("0001", "hex"), Buffer.from("414243ff", "hex")];
    const words = bytes.flatMap((buffer) => {
      const values = Array.from({ length: buffer.length / 2 }, (_, i) => buffer.readUInt16BE(i * 2));
      return endian === "Little-Endian" ? values.reverse() : values;
    });
    const values = decodeCustomisedDatablock(words, config);
    assert.deepEqual(values, {
      signed: -2, unsigned: 65535, counter: 4294967295, negative: -2147483648,
      maximum: "18446744073709551615", minimum: "-9223372036854775808",
      temperature: 12.5, measurement: Math.PI, running: true, name: "ABC",
    });
    assert.deepEqual(JSON.parse(JSON.stringify(values)), values);
  });
}

test("edited layout size controls the request size, offsets and topics of consecutive blocks", async () => {
  const config = normaliseCustomisedConfig({ ...base, blockCount: 3,
    fields: [field("count", "UDINT", 32), field("part", "STRING", 24)],
    blockTopics: ["a", "b", "c"],
  });
  const calls = [];
  const blocks = await readCustomisedDatablocks({ readHoldingRegisters: async (address, count) => {
    calls.push([address, count]);
    return { data: [0, 42, 0x4142, 0x4300, 0, 43, 0x4445, 0x4600, 0, 44, 0x4748, 0x4900] };
  } }, config);
  assert.deepEqual(calls, [[100, 12]]);
  assert.deepEqual(blocks.map((b) => [b.startAddress, b.topic, b.values]), [
    [100, "a", { count: 42, part: "ABC" }], [104, "b", { count: 43, part: "DEF" }],
    [108, "c", { count: 44, part: "GHI" }],
  ]);
});

for (const endian of ["Big-Endian", "Little-Endian"]) {
  test(`${endian}: all block sizes 1–125 stay in one response with correct addresses, values and topics`, async () => {
    for (let size = 1; size <= 125; size++) {
      // Two full requests and a final single block exercise batching and leftovers.
      const blockCount = Math.floor(125 / size) * 2 + 1;
      const byteLength = (size - 1) * 2 - 1;
      const fields = [field("marker", "UINT", 16)];
      if (size > 1) fields.push(field("text", "STRING", byteLength * 8));
      const config = normalizeModbusConfig({ ...base, readMode: "Read by Datablocks", layoutMode: "custom",
        registerCount: blockCount, fields, endian,
        blockTopics: Array.from({ length: blockCount }, (_, index) => `size/${size}/block/${index + 1}`),
      });
      const expected = [];
      const words = [];
      for (let index = 0; index < blockCount; index++) {
        const character = 65 + index % 26;
        const textWords = Array(size - 1).fill(character * 257);
        if (size > 1) textWords[textWords.length - 1] = character * 256 + 255;
        if (endian === "Little-Endian") textWords.reverse();
        words.push(index + 1, ...textWords);
        expected.push({ index, startAddress: 100 + index * size, registerCount: size,
          topic: config.blockTopics[index], values: { marker: index + 1,
            ...(size > 1 ? { text: String.fromCharCode(character).repeat(byteLength) } : {}),
          },
        });
      }
      let nextAddress = 100;
      const calls = [];
      const blocks = await readModbusSample({ readHoldingRegisters: async (address, count) => {
        assert.equal(address, nextAddress, `size ${size}: no gaps or duplicate reads`);
        assert.equal((address - 100) % size, 0, `size ${size}: starts on a block boundary`);
        assert.equal(count % size, 0, `size ${size}: ends on a block boundary`);
        assert.ok(count > 0 && count <= 125, `size ${size}: valid request size`);
        calls.push([address, count]);
        nextAddress += count;
        return { data: words.slice(address - 100, address - 100 + count) };
      } }, config);
      assert.equal(calls.length, 3, `size ${size}: batch as many whole blocks as fit`);
      assert.equal(calls.at(-1)[1], size);
      assert.equal(nextAddress, 100 + words.length);
      assert.deepEqual(blocks, expected, `size ${size}: preserve block boundaries and MQTT topic mapping`);
    }
  });
}

test("oversized blocks are rejected before reading instead of being split", async () => {
  for (const fields of [
    [field("text", "STRING", 251 * 8)],
    [field("text", "STRING", 250 * 8), field("tail", "UINT", 16)],
    Array.from({ length: 126 }, (_, index) => field(`value${index}`, "UINT", 16)),
  ]) {
    assert.throws(() => buildCustomisedLayout(fields), /125 registers/);
    assert.throws(() => normaliseCustomisedConfig({ ...base, fields }), /125 registers/);
    assert.throws(() => normalizeModbusConfig({ ...base, fields,
      readMode: "Read by Datablocks", layoutMode: "custom", registerCount: 1,
    }), { name: ModbusConfigurationError.name, message: /125 registers/ });
  }
  const config = normaliseCustomisedConfig(base);
  let calls = 0;
  const client = { readHoldingRegisters: async () => { calls++; return { data: [] }; } };
  for (const registersPerBlock of [0, 126, 131, NaN, 2.5]) {
    await assert.rejects(readCustomisedDatablocks(client, { ...config, registersPerBlock }), /1 to 125/);
  }
  assert.equal(calls, 0);
});

test("a 125-register block can end at the final Modbus address in one request", async () => {
  const config = normaliseCustomisedConfig({ ...base, startAddress: 65411,
    fields: [field("text", "STRING", 250 * 8)],
  });
  const calls = [];
  const blocks = await readCustomisedDatablocks({ readHoldingRegisters: async (address, count) => {
    calls.push([address, count]);
    return { data: Array(count).fill(0x4141) };
  } }, config);
  assert.deepEqual(calls, [[65411, 125]]);
  assert.equal(blocks[0].values.text, "A".repeat(250));
  assert.throws(() => normaliseCustomisedConfig({ ...config, startAddress: 65412 }), /65535/);
});

test("validates field names, widths, topics and final register boundaries", () => {
  for (const fields of [[], [field("", "UINT", 16)], [field("x", "UINT", 32)],
    [field("x", "STRING", 7)], [field("x", "STRING", 0)], [field("x", "STRING", "")],
    [field("x", "unknown", 16)], [field("A", "UINT", 16), field("a", "UINT", 16)]]) {
    assert.throws(() => normaliseCustomisedConfig({ ...base, fields }));
  }
  for (const config of [{ startAddress: 65500 }, { blockCount: 0 }, { blockCount: 2 },
    { blockTopics: ["a/+"] }, { blockTopics: [""] }, { endian: "unsupported" }, { unitId: 256 }, { polling: "" }]) {
    assert.throws(() => normaliseCustomisedConfig({ ...base, ...config }));
  }
  const config = normaliseCustomisedConfig({ ...base, startAddress: 65535, fields: [field("last", "UINT", 16)] });
  assert.equal(config.registersPerBlock, 1);
});

test("rejects truncated or invalid responses and non-finite floats", async () => {
  const config = normaliseCustomisedConfig({ ...base, fields: [field("real", "REAL", 32)] });
  for (const data of [[0], [0, -1], [0, 65536], [0x7f80, 0]]) {
    await assert.rejects(readCustomisedDatablocks({ readHoldingRegisters: async () => ({ data }) }, config));
  }
});


test("unified Modbus config selects dynamic layouts explicitly and keeps legacy defaults", async () => {
  const config = normalizeModbusConfig({ ...base, readMode: "Read by Datablocks", layoutMode: "custom", registerCount: 1,
    fields: [field("myCount", "UDINT", 32), field("myName", "STRING", 16)] });
  assert.equal(config.registersPerBlock, 3);
  assert.equal(config.blockCount, 1);
  const sample = await readModbusSample({ readHoldingRegisters: async (address, count) => {
    assert.equal(address, 100); assert.equal(count, 3);
    return { data: [0, 42, 0x4142] };
  } }, config);
  assert.deepEqual(sample[0].values, { myCount: 42, myName: "AB" });
  const legacy = normalizeModbusConfig({ ...base, readMode: "Read by Datablocks", registerCount: 1 });
  const result = await readModbusSample({ readHoldingRegisters: async (_address, count) => {
    assert.equal(count, 58); return { data: Array(58).fill(0) };
  } }, legacy);
  assert.ok(Object.hasOwn(result[0].values, "cycle_counter"));
  assert.throws(() => normalizeModbusConfig({ ...config, fields: [] }), ModbusConfigurationError);
  assert.throws(() => normalizeModbusConfig({ ...config, layoutMode: "invalid" }), ModbusConfigurationError);
});
