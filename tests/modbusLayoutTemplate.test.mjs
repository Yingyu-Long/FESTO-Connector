import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import writeXlsxFile from "write-excel-file/node";
import { readSheet } from "read-excel-file/node";
import { createModbusLayoutRows, parseModbusLayoutRows, MODBUS_LAYOUT_SHEET, MODBUS_LAYOUT_HEADERS } from "../shared/modbusLayoutTemplate.js";
import { buildCustomisedLayout, customisedExampleFields } from "../shared/modbusCustomised.js";
import * as standard from "../shared/modbusDatablock.js";

const workbook = (rows, sheet) => writeXlsxFile(rows.map((row) => row.map((value) => ({ value, type: typeof value === "number" ? Number : String }))), { sheet }).toBuffer();

test("layout Excel roundtrip preserves names, field order and byte/bit widths", async () => {
  const fields = [...customisedExampleFields().reverse(), { name: "=literal_变量", dataType: "STRING", bitWidth: 24 }];
  const buffer = await workbook(createModbusLayoutRows(fields), MODBUS_LAYOUT_SHEET);
  const rows = await readSheet(buffer, MODBUS_LAYOUT_SHEET);
  const imported = parseModbusLayoutRows(rows);
  assert.deepEqual(imported, fields);
  const layout = buildCustomisedLayout(imported);
  assert.equal(layout.registerCount, 60);
  assert.equal(layout.fields[0].bitWidth, 384);
  assert.equal(layout.fields[0].registerCount, 24);
  assert.equal(layout.fields.at(-1).offset, 58);
});

test("blank rows in the editor download with unique editable placeholders", () => {
  const fields = [{ name: "", dataType: "UINT", bitWidth: 16 }, { name: "field_1", dataType: "UINT", bitWidth: 16 }];
  const imported = parseModbusLayoutRows(createModbusLayoutRows(fields));
  assert.equal(imported.length, 2);
  assert.notEqual(imported[0].name, imported[1].name);
  assert.equal(fields[0].name, "", "export must not change the editor");
  const blank = createModbusLayoutRows([{ name: "", dataType: "", bitWidth: "" }]);
  assert.deepEqual(blank[1].slice(1), ["", "", ""], "an empty layout still downloads without preset type or width");
  blank[1] = ["userField", "UDINT", 32, "bits"];
  assert.deepEqual(parseModbusLayoutRows(blank), [{ name: "userField", dataType: "UDINT", bitWidth: 32 }]);
});

test("layout imports reject wrong headers, missing names, duplicate names and incompatible widths", () => {
  const headers = [...MODBUS_LAYOUT_HEADERS];
  for (const row of [["x", "ULINT", 32, "bits"], ["", "UINT", 16, "bits"], ["x", "STRING", 7, "bits"],
    ["x", "UINT", 16, "bytes"], ["x", "STRING", "", "bytes"], ["x", "STRING", true, "bytes"], ["x", "unknown", 32, "bits"]]) {
    assert.throws(() => parseModbusLayoutRows([headers, row]));
  }
  assert.throws(() => parseModbusLayoutRows([["FB", "MQTT topic"], [1, "fb/one"]]));
  assert.throws(() => parseModbusLayoutRows([headers]));
  assert.throws(() => parseModbusLayoutRows([headers, ["x", "UINT", 16, "bits"], ["X", "UINT", 16, "bits"]]), /duplicated/);
  assert.throws(() => parseModbusLayoutRows([headers, ["x", "STRING", 131073, "bytes"]]));
  assert.throws(() => parseModbusLayoutRows([headers, ["x", "STRING", 251, "bytes"]]), /125 registers/);
  assert.throws(() => parseModbusLayoutRows([headers, ["x", "STRING", 250, "bytes"], ["tail", "UINT", 16, "bits"]]), /125 registers/);
  assert.deepEqual(parseModbusLayoutRows([headers, [], [" name ", " string ", 3, "bytes"], [null, null, null, null]]), [{ name: "name", dataType: "STRING", bitWidth: 24 }]);
});

function loadTs(relativePath) {
  const filename = new URL(relativePath, import.meta.url);
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, TextEncoder,
    require: (name) => { assert.ok(name.endsWith("modbusDatablock.js")); return standard; },
  });
  return module.exports;
}

test("MQTT templates roundtrip custom block sizes and validate dynamic address boundaries", async () => {
  const { createDatablockTemplateRows } = loadTs("../src/app/Add/modbusDatablockTemplate.ts");
  const { parseDatablockRows } = loadTs("../src/app/Add/modbusDatablockImport.ts");
  for (const [registersPerBlock, startAddress, blockCount] of [[1, 65534, 2], [125, 65286, 2], [58, 65478, 1]]) {
    const blockTopics = Array.from({ length: blockCount }, (_, index) => `fb/${index + 1}`);
    const settings = { registersPerBlock, startAddress, blockCount, polling: 500, blockTopics };
    const rows = createDatablockTemplateRows(settings).map((row) => row.map((cell) => cell.value));
    const buffer = await workbook(rows, "Datablocks");
    const imported = parseDatablockRows(await readSheet(buffer, "Datablocks"), registersPerBlock);
    assert.deepEqual(JSON.parse(JSON.stringify(imported)), { startAddress, polling: 500, blockTopics });
  }
  const invalid = { registersPerBlock: 125, startAddress: 65300, blockCount: 2, polling: 500, blockTopics: ["a", "b"] };
  assert.throws(() => createDatablockTemplateRows(invalid));
  const rows = createDatablockTemplateRows({ ...invalid, registersPerBlock: 58 }).map((row) => row.map((cell) => cell.value));
  assert.throws(() => parseDatablockRows(rows, 125), /65535/);
  assert.doesNotThrow(() => parseDatablockRows(rows), "existing templates still default to 58 registers");
  assert.throws(() => parseDatablockRows(rows, 0));
  assert.throws(() => parseDatablockRows(rows, 126));
  assert.throws(() => createDatablockTemplateRows({ ...invalid, startAddress: 0, registersPerBlock: 126 }));
});
