import assert from "node:assert/strict";
import test, { mock } from "node:test";

const identifiers = new Map([[2, "cylinder"], [52, "valve"], [102, "terminal"]]);
const messages = [];
let reads = 0;
class S7Client {
  ConnectTo(_host, _rack, _slot, callback) { callback(); }
  Disconnect() {}
  DBRead(_db, offset, size, callback) {
    reads++;
    const buffer = Buffer.alloc(size);
    if (offset === 500) {
      buffer.writeInt32BE(-123, 0);
      for (let index = 1; index < 8; index++) {
        buffer.writeInt32BE(index * 100, index * 4);
      }
      buffer.writeUInt32BE(42, 32);
    } else {
      const value = identifiers.get(offset) ?? "";
      buffer[0] = 48;
      buffer[1] = Buffer.byteLength(value);
      buffer.write(value, 2);
    }
    callback(null, buffer);
  }
}
mock.module("node-snap7", { defaultExport: { S7Client } });
mock.module(new URL("../server/mqttPublisher.js", import.meta.url).href, {
  namedExports: {
    publishPayload: async (_mqtt, topic, payload) => {
      messages.push({ topic, payload });
      return true;
    },
  },
});
const { readSiemensMipMessage } = await import("../server/plc/siemensReader.js");
const { startSiemensPoller, stopSiemensPoller, getSiemensPollerStatus } =
  await import("../server/plc/poller.js");
const config = {
  id: "s7-topic-test", host: "plc", messageLayout: "mip",
  dataBlocks: [{ range: "DB1" }], polling: 60000,
};

test("manual topics override PLC IDs and preserve the MIP payload", async () => {
  const automatic = await readSiemensMipMessage(new S7Client(), config);
  const manual = await readSiemensMipMessage(new S7Client(), {
    ...config, mqttTopic: "  factory/产线/s7  ",
  });
  assert.equal(automatic.topic, "festo-ax/pni/terminal/valve/cylinder");
  assert.equal(manual.topic, "factory/产线/s7");
  assert.deepEqual(manual.payload, automatic.payload);
  assert.deepEqual(manual.payload, {
    timestamp_DI_IPos_ON: -123,
    timestamp_DI_IPos_OFF: 100,
    timestamp_DI_EPos_ON: 200,
    timestamp_DI_EPos_OFF: 300,
    timestamp_DO_MCtrl12_ON: 400,
    timestamp_DO_MCtrl12_OFF: 500,
    timestamp_DO_MCtrl14_ON: 600,
    timestamp_DO_MCtrl14_OFF: 700,
    cycle_counter: 42,
  });
});

test("blank topics preserve automatic routing, including identifier escaping", async () => {
  identifiers.set(52, "valve/+#");
  try {
    const message = await readSiemensMipMessage(new S7Client(), { ...config, mqttTopic: "  " });
    assert.equal(message.topic, "festo-ax/pni/terminal/valve%2F%2B%23/cylinder");
  } finally {
    identifiers.set(52, "valve");
  }
});

test("manual routing works when PLC identifier strings are empty", async () => {
  identifiers.set(2, "");
  try {
    const message = await readSiemensMipMessage(new S7Client(), { ...config, mqttTopic: "factory/s7" });
    assert.equal(message.topic, "factory/s7");
    await assert.rejects(readSiemensMipMessage(new S7Client(), config), /sCylinderID is empty/);
  } finally {
    identifiers.set(2, "cylinder");
  }
});

test("invalid topics are rejected before reading PLC data", async () => {
  const readsBefore = reads;
  for (const mqttTopic of ["a/+", "a/#", "a\0b", "a".repeat(65536), "中".repeat(21846), 123]) {
    await assert.rejects(readSiemensMipMessage(new S7Client(), { ...config, mqttTopic }), /Invalid MQTT publish topic/);
  }
  assert.equal(reads, readsBefore);
  const message = await readSiemensMipMessage(new S7Client(), { ...config, mqttTopic: "a".repeat(65535) });
  assert.equal(message.topic.length, 65535);
});

test("poller publishes to the configured topic and updates it on reconnect", async (t) => {
  t.after(() => stopSiemensPoller(config.id));
  await startSiemensPoller({ ...config, mqttTopic: "factory/first" });
  assert.equal(messages.at(-1).topic, "factory/first");
  assert.equal(getSiemensPollerStatus(config.id).dataBlocks[0].mqttTopic, "factory/first");
  await startSiemensPoller({ ...config, mqttTopic: "factory/second" });
  assert.equal(messages.at(-1).topic, "factory/second");
  await startSiemensPoller({ ...config, mqttTopic: "" });
  assert.equal(messages.at(-1).topic, "festo-ax/pni/terminal/valve/cylinder");
});
