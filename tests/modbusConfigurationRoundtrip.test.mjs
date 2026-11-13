import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import * as standard from "../shared/modbusDatablock.js";
import * as custom from "../shared/modbusCustomised.js";

test("custom field order and widths survive save/export/import and reconnect through the unified endpoint", async () => {
  const storage = new Map();
  storage.set("festo-mqtt-config", JSON.stringify({ host: "broker", port: "1883", protocol: "tcp://" }));
  const requests = [];
  const cache = new Map();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const globals = {
    URL, URLSearchParams, TextEncoder, AbortController, crypto: { randomUUID: () => "configuration-id" },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { setTimeout, clearTimeout },
    fetch: async (endpoint, options) => { requests.push({ endpoint, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ connected: true }) }; },
  };
  const load = (file) => {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const require = (specifier) => {
      if (specifier.endsWith("modbusDatablock.js")) return standard;
      if (specifier.endsWith("modbusCustomised.js")) return custom;
      return load(resolve(dirname(file), `${specifier}.ts`));
    };
    vm.runInNewContext(source, { ...globals, module, exports: module.exports, require }, { filename: file });
    return module.exports;
  };
  const { saveConnection, readSavedConnections } = load(resolve(root, "src/app/storage.ts"));
  const { buildConfiguration } = load(resolve(root, "src/app/configuration.ts"));
  const { prepareConfiguration, storeConfiguration } = load(resolve(root, "src/app/configurationImport.ts"));
  const { reconnect } = load(resolve(root, "src/app/Dashboard/connections.ts"));
  const fields = [{ name: "part", dataType: "STRING", bitWidth: 24 }, { name: "count", dataType: "ULINT", bitWidth: 64 }];
  const connection = { recordId: "custom-record", id: "custom", protocol: "modbus.tcp", host: "plc", port: "502", status: "disconnected", details: "Custom layout",
    config: { readMode: "Read by Datablocks", layoutMode: "custom", fields, registerCount: "2", startAddress: "100", blockTopics: ["fb/one", "fb/two"] } };
  const legacy = { ...connection, recordId: "standard-record", id: "standard", config: { readMode: "Read by Datablocks", registerCount: "1", blockTopics: ["standard/one"] } };
  saveConnection(connection); saveConnection(legacy);
  const exported = JSON.parse(JSON.stringify(buildConfiguration(readSavedConnections())));
  const imported = prepareConfiguration(exported);
  storeConfiguration(imported);
  const restored = JSON.parse(JSON.stringify(readSavedConnections()));
  assert.deepEqual(restored[0].config.fields, fields);
  assert.equal(restored[0].protocol, "modbus.tcp");
  assert.equal(restored[0].config.layoutMode, "custom");
  assert.equal(restored[1].config.layoutMode, undefined, "old configurations need no migration to keep standard behavior");
  await reconnect(restored[0]); await reconnect(restored[1]);
  assert.equal(requests[0].endpoint, "/api/plcs/modbus/connect");
  assert.equal(requests[0].body.layoutMode, "custom");
  assert.deepEqual(requests[0].body.fields, fields);
  assert.equal(requests[0].body.registerCount, "2");
  assert.equal(requests[1].body.layoutMode, "standard");
  // Saved experimental records must not be lost when IDs coincide.
  saveConnection({ ...connection, recordId: "experimental-record", protocol: custom.CUSTOMISED_PROTOCOL, config: { ...connection.config, blockCount: 2 } });
  const withExperimental = prepareConfiguration(JSON.parse(JSON.stringify(buildConfiguration(readSavedConnections()))));
  assert.equal(withExperimental.connections.length, 3);
  assert.equal(withExperimental.connections[2].protocol, custom.CUSTOMISED_PROTOCOL);
});
