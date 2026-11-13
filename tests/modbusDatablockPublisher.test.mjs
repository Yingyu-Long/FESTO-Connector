import assert from "node:assert/strict";
import test from "node:test";
import { createModbusDatablockPublisher } from "../server/plc/modbusDatablockPublisher.js";

const config = { mqtt: { host: "broker", port: 1883, qos: 1 } };
function block(timestamp, startAddress = 0, topic = "fb/1", extra = {}) {
  return {
    startAddress,
    topic,
    values: {
      timestamp_DI_IPos_ON: timestamp,
      timestamp_DI_IPos_OFF: "2",
      timestamp_DI_EPos_ON: "3",
      timestamp_DI_EPos_OFF: "4",
      timestamp_DO_MCtrl12_ON: "5",
      timestamp_DO_MCtrl12_OFF: "6",
      timestamp_DO_MCtrl14_ON: "7",
      timestamp_DO_MCtrl14_OFF: "8",
      cycle_counter: 9,
      part_number: "part",
      ...extra,
    },
  };
}
function recordingPublisher() {
  const messages = [];
  const publish = createModbusDatablockPublisher(async (mqtt, topic, values) => {
    messages.push({ mqtt, topic, values: JSON.parse(JSON.stringify(values)) });
    return true;
  });
  return { publish, messages };
}

test("sends a zero baseline once and gates the whole group on the trigger only", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [block("0")]);
  assert.equal(messages.length, 1);
  assert.equal(Object.keys(messages[0].values).length, 11);
  const updated = block("0", 0, "fb/1", { cycle_counter: 42, part_number: "new" });
  assert.equal(await publish(config, [updated]), true);
  assert.equal(messages.length, 1);
  updated.values.timestamp_DI_IPos_ON = "1";
  await publish(config, [updated]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].values, {
    timestamp_DI_IPos_ON: 1,
    timestamp_DI_IPos_OFF: 2,
    timestamp_DI_EPos_ON: 3,
    timestamp_DI_EPos_OFF: 4,
    timestamp_DO_MCtrl12_ON: 5,
    timestamp_DO_MCtrl12_OFF: 6,
    timestamp_DO_MCtrl14_ON: 7,
    timestamp_DO_MCtrl14_OFF: 8,
    cycle_counter: 42,
    part_number: "new",
    isThisAutomaticMode: true,
  });
});

test("publishes the example timestamps as JSON numbers with exactly the requested fields", async () => {
  const { publish, messages } = recordingPublisher();
  const expected = {
    timestamp_DI_EPos_OFF: 1792564286216,
    timestamp_DI_EPos_ON: 1792564286189,
    timestamp_DO_MCtrl12_OFF: 1792564286135,
    timestamp_DO_MCtrl12_ON: 1792564286200,
    timestamp_DO_MCtrl14_OFF: 1792564286200,
    timestamp_DO_MCtrl14_ON: 1792564286135,
    timestamp_DI_IPos_OFF: 1792564286155,
    timestamp_DI_IPos_ON: 1792564286249,
    cycle_counter: 461,
    part_number: "part",
    isThisAutomaticMode: true,
  };
  const timestamps = Object.fromEntries(Object.entries(expected)
    .filter(([name]) => name.startsWith("timestamp_"))
    .map(([name, value]) => [name, String(value)]));
  const sample = block(timestamps.timestamp_DI_IPos_ON, 0,
    "festo-ax/pni/Local/MyPC/simulation/MIP/Times", {
      ...timestamps, cycle_counter: 461, isThisAutomaticMode: false,
    });
  await publish(config, [sample]);
  assert.deepEqual(messages[0].values, expected);
  assert.equal(messages[0].topic, sample.topic);
  assert.equal(sample.values.part_number, "part");
  assert.equal(typeof sample.values.timestamp_DI_IPos_ON, "string");
});

test("preserves exact numeric timestamps at the safe integer boundary and detects resets", async () => {
  const { publish, messages } = recordingPublisher();
  for (const value of ["9007199254740990", "9007199254740991", "9007199254740991", "0"]) {
    await publish(config, [block(value)]);
  }
  assert.deepEqual(messages.map((m) => m.values.timestamp_DI_IPos_ON),
    [9007199254740990, 9007199254740991, 0]);
});

test("rejects unsafe timestamps without publishing rounded values or consuming the trigger", async () => {
  const { publish, messages } = recordingPublisher();
  for (const value of ["9007199254740992", "9007199254740993", "18446744073709551615"]) {
    await assert.rejects(publish(config, [block(value)]), /exact JSON number/);
  }
  await assert.rejects(publish(config, [block("1", 0, "fb/1", {
    timestamp_DI_EPos_OFF: "9007199254740993",
  })]), /timestamp_DI_EPos_OFF/);
  assert.equal(messages.length, 0);
  await publish(config, [block("1")]);
  assert.equal(messages.length, 1);
});

test("test mode publishes every FB on every round and disabling it restores change detection", async () => {
  const { publish, messages } = recordingPublisher();
  const blocks = [block("0"), block("0", 58, "fb/2")];
  await publish(config, blocks);
  await publish({ ...config, testMode: true }, blocks);
  blocks[0].values.cycle_counter = 42;
  blocks[1].values.timestamp_DI_IPos_ON = "7";
  await publish({ ...config, testMode: true }, blocks);
  assert.deepEqual(messages.map((message) => message.topic),
    ["fb/1", "fb/2", "fb/1", "fb/2", "fb/1", "fb/2"]);
  assert.equal(messages[4].values.cycle_counter, 42);
  assert.equal(messages[5].values.timestamp_DI_IPos_ON, 7);
  assert.equal(messages[4].values.isThisAutomaticMode, true);
  assert.equal(messages[5].values.isThisAutomaticMode, true);
  await publish({ ...config, testMode: false }, blocks);
  assert.equal(messages.length, 6);
  blocks[0].values.timestamp_DI_IPos_ON = "1";
  await publish({ ...config, testMode: false }, blocks);
  assert.equal(messages.length, 7);
  assert.equal(messages[6].topic, "fb/1");
});

test("a failed test-mode delivery does not advance the normal-mode baseline", async () => {
  let delivered = false;
  let attempts = 0;
  const publish = createModbusDatablockPublisher(async () => {
    attempts++;
    return delivered;
  });
  assert.equal(await publish({ ...config, testMode: true }, [block("0")]), false);
  delivered = true;
  assert.equal(await publish({ ...config, testMode: false }, [block("0")]), true);
  await publish({ ...config, testMode: false }, [block("0")]);
  assert.equal(attempts, 2);
});

test("tracks FBs independently, even when their timestamps and topics match", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [block("1"), block("1", 58)]);
  await publish(config, [block("1"), block("2", 58, "fb/1", { cycle_counter: 12 })]);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].values.cycle_counter, 12);
});

test("a failed publish is retried without repeating successfully delivered FBs", async () => {
  const attempts = [];
  let fail = true;
  const publish = createModbusDatablockPublisher(async (_mqtt, topic) => {
    attempts.push(topic);
    if (topic === "fb/2" && fail) throw new Error("broker unavailable");
    return true;
  });
  const blocks = [block("1"), block("1", 58, "fb/2")];
  await assert.rejects(publish(config, blocks), /broker unavailable/);
  fail = false;
  assert.equal(await publish(config, blocks), true);
  assert.deepEqual(attempts, ["fb/1", "fb/2", "fb/2"]);
});

test("an unconfigured or unsuccessful MQTT delivery does not consume a change", async () => {
  let delivered = false;
  let attempts = 0;
  const publish = createModbusDatablockPublisher(async () => { attempts++; return delivered; });
  assert.equal(await publish(config, [block("7")]), false);
  delivered = true;
  assert.equal(await publish(config, [block("7")]), true);
  await publish(config, [block("7")]);
  assert.equal(attempts, 2);
});

test("polling updates preserve the baseline, while a new MQTT destination gets a snapshot", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [block("1")]);
  await publish({ ...config, polling: 100 }, [block("1")]);
  assert.equal(messages.length, 1);
  await publish({ mqtt: { ...config.mqtt, host: "new-broker" } }, [block("1")]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].mqtt.host, "new-broker");
});

test("new topics and start addresses receive a snapshot; removed FBs forget their baseline", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [block("1"), block("2", 58, "fb/2")]);
  await publish(config, [block("1", 0, "new/topic"), block("2", 58, "fb/2")]);
  assert.equal(messages.length, 3);
  await publish(config, [block("1", 26000, "new/topic")]);
  assert.equal(messages.length, 4);
  await publish(config, [block("1", 26000, "new/topic"), block("2", 58, "fb/2")]);
  assert.equal(messages.length, 5);
});

test("separate PLC pollers have independent baselines", async () => {
  const first = recordingPublisher();
  const second = recordingPublisher();
  await first.publish(config, [block("1")]);
  await second.publish(config, [block("1")]);
  await first.publish(config, [block("1")]);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
});
