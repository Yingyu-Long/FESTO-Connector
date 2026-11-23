import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModbusDatablockPublisher,
  isConsistentCylinderCycle,
  extractCylinderCycleTimestamps,
} from "../server/plc/modbusDatablockPublisher.js";

const config = { mqtt: { host: "broker", port: 1883, qos: 1 } };

// Generates a valid extend-first cylinder cycle starting at `base` ms:
// MCtrl14_ON (+0) < IPos_OFF (+15) < EPos_ON (+50) <= MCtrl12_ON (+65) < EPos_OFF (+80) < IPos_ON (+110)
function cycleBlock(base, startAddress = 0, topic = "fb/1", extra = {}) {
  const b = BigInt(base);
  return {
    startAddress,
    topic,
    values: {
      timestamp_DO_MCtrl14_ON: String(b),
      timestamp_DO_MCtrl12_OFF: String(b),
      timestamp_DI_IPos_OFF: String(b + 15n),
      timestamp_DI_EPos_ON: String(b + 50n),
      timestamp_DO_MCtrl12_ON: String(b + 65n),
      timestamp_DO_MCtrl14_OFF: String(b + 65n),
      timestamp_DI_EPos_OFF: String(b + 80n),
      timestamp_DI_IPos_ON: String(b + 110n),
      cycle_counter: 9,
      part_number: "part",
      ...extra,
    },
  };
}

// Generates a valid retract-first cylinder cycle (resting at EPos):
// MCtrl12_ON (+0) < EPos_OFF (+20) < IPos_ON (+70) <= MCtrl14_ON (+100) < IPos_OFF (+115) < EPos_ON (+160)
function retractFirstCycleBlock(base, startAddress = 0, topic = "fb/1", extra = {}) {
  const b = BigInt(base);
  return {
    startAddress,
    topic,
    values: {
      timestamp_DO_MCtrl12_ON: String(b),
      timestamp_DO_MCtrl14_OFF: String(b),
      timestamp_DI_EPos_OFF: String(b + 20n),
      timestamp_DI_IPos_ON: String(b + 70n),
      timestamp_DO_MCtrl14_ON: String(b + 100n),
      timestamp_DO_MCtrl12_OFF: String(b + 100n),
      timestamp_DI_IPos_OFF: String(b + 115n),
      timestamp_DI_EPos_ON: String(b + 160n),
      cycle_counter: 9,
      part_number: "part",
      ...extra,
    },
  };
}

function recordingPublisher(options) {
  const messages = [];
  const publish = createModbusDatablockPublisher(async (mqtt, topic, values) => {
    messages.push({ mqtt, topic, values: JSON.parse(JSON.stringify(values)) });
    return true;
  }, options);
  return { publish, messages };
}

test("skips zero/uninitialized and torn mid-stroke cycles, publishes only complete consistent cycles", async () => {
  const { publish, messages } = recordingPublisher();

  // All-zero PLC boot baseline is silently skipped.
  const zeroBlock = cycleBlock(1000, 0, "fb/1", {
    timestamp_DO_MCtrl14_ON: "0",
    timestamp_DO_MCtrl12_OFF: "0",
    timestamp_DI_IPos_OFF: "0",
    timestamp_DI_EPos_ON: "0",
    timestamp_DO_MCtrl12_ON: "0",
    timestamp_DO_MCtrl14_OFF: "0",
    timestamp_DI_EPos_OFF: "0",
    timestamp_DI_IPos_ON: "0",
  });
  assert.equal(await publish(config, [zeroBlock]), true);
  assert.equal(messages.length, 0);

  // First complete cycle publishes.
  const cycle1 = cycleBlock(1000, 0, "fb/1", { cycle_counter: 1 });
  assert.equal(await publish(config, [cycle1]), true);
  assert.equal(messages.length, 1);
  assert.equal(Object.keys(messages[0].values).length, 11);

  // Unchanged cycle timestamps (even if counter/part_number changes) are suppressed.
  const unchanged = cycleBlock(1000, 0, "fb/1", { cycle_counter: 42, part_number: "new" });
  assert.equal(await publish(config, [unchanged]), true);
  assert.equal(messages.length, 1);

  // Mid-stroke torn read: extend updated to cycle 2 (2000..2050), retract still cycle 1 (1065..1110).
  const tornExtend = {
    ...cycle1,
    values: {
      ...cycle1.values,
      timestamp_DO_MCtrl14_ON: "2000",
      timestamp_DI_IPos_OFF: "2015",
      timestamp_DI_EPos_ON: "2050",
    },
  };
  assert.equal(await publish(config, [tornExtend]), true);
  assert.equal(messages.length, 1, "torn extend+old retract must not be published");

  // Mid-stroke torn read: retract started (2065..2080) but IPos_ON still cycle 1 (1110).
  const tornRetract = {
    ...tornExtend,
    values: {
      ...tornExtend.values,
      timestamp_DO_MCtrl12_ON: "2065",
      timestamp_DI_EPos_OFF: "2080",
    },
  };
  assert.equal(await publish(config, [tornRetract]), true);
  assert.equal(messages.length, 1, "torn retract with old IPos_ON must not be published");

  // Partial update where only IPos_ON bumped while the other 5 stayed on cycle 1.
  const partialBump = cycleBlock(1000, 0, "fb/1", { timestamp_DI_IPos_ON: "1120" });
  assert.equal(await publish(config, [partialBump]), true);
  assert.equal(messages.length, 1, "partial single-timestamp bump must not publish");

  // Complete cycle 2 (all 6 timestamps advanced and strictly consistent) publishes!
  const cycle2 = cycleBlock(2000, 0, "fb/1", { cycle_counter: 2, part_number: "new" });
  assert.equal(await publish(config, [cycle2]), true);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1].values, {
    timestamp_DI_IPos_ON: 2110,
    timestamp_DI_IPos_OFF: 2015,
    timestamp_DI_EPos_ON: 2050,
    timestamp_DI_EPos_OFF: 2080,
    timestamp_DO_MCtrl12_ON: 2065,
    timestamp_DO_MCtrl12_OFF: 2000,
    timestamp_DO_MCtrl14_ON: 2000,
    timestamp_DO_MCtrl14_OFF: 2065,
    cycle_counter: 2,
    part_number: "new",
    isThisAutomaticMode: true,
  });
});

test("supports retract-first cycles and arbitrary dwell/stroke times across heterogeneous cylinders", async () => {
  const { publish, messages } = recordingPublisher();
  // Retract-first cylinder with long dwell (60s between IPos_ON and MCtrl14_ON)
  const slowRetractFirst = retractFirstCycleBlock(10000, 0, "fb/retract");
  slowRetractFirst.values.timestamp_DO_MCtrl14_ON = "70000";
  slowRetractFirst.values.timestamp_DI_IPos_OFF = "70500";
  slowRetractFirst.values.timestamp_DI_EPos_ON = "75000";
  assert.equal(isConsistentCylinderCycle(extractCylinderCycleTimestamps(slowRetractFirst.values)), true);

  await publish(config, [slowRetractFirst]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].topic, "fb/retract");

  // Next complete retract-first cycle publishes
  const nextRetractFirst = retractFirstCycleBlock(100000, 0, "fb/retract");
  await publish(config, [nextRetractFirst]);
  assert.equal(messages.length, 2);
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
  const sample = cycleBlock(1000, 0,
    "festo-ax/pni/Local/MyPC/simulation/MIP/Times", {
      ...timestamps, cycle_counter: 461, isThisAutomaticMode: false,
    });
  await publish(config, [sample]);
  assert.deepEqual(messages[0].values, expected);
  assert.equal(messages[0].topic, sample.topic);
  assert.equal(sample.values.part_number, "part");
  assert.equal(typeof sample.values.timestamp_DI_IPos_ON, "string");
});

test("preserves exact numeric timestamps at the safe integer boundary and detects PLC clock resets", async () => {
  const { publish, messages } = recordingPublisher();
  const maxBase = 9007199254740881n; // maxBase + 110n === 9007199254740991n (Number.MAX_SAFE_INTEGER)
  const nearMax = 9007199254740700n;
  for (const base of [nearMax, maxBase, maxBase, 100n]) {
    await publish(config, [cycleBlock(base)]);
  }
  assert.deepEqual(
    messages.map((m) => m.values.timestamp_DI_IPos_ON),
    [Number(nearMax + 110n), 9007199254740991, 210],
  );
});

test("rejects unsafe timestamps without publishing rounded values or consuming the baseline", async () => {
  const { publish, messages } = recordingPublisher();
  for (const value of ["9007199254740992", "9007199254740993", "18446744073709551615"]) {
    await assert.rejects(
      publish(config, [cycleBlock(1000, 0, "fb/1", { timestamp_DI_IPos_ON: value })]),
      /exact JSON number/,
    );
  }
  await assert.rejects(
    publish(config, [cycleBlock(1000, 0, "fb/1", { timestamp_DI_EPos_OFF: "9007199254740993" })]),
    /timestamp_DI_EPos_OFF/,
  );
  assert.equal(messages.length, 0);
  await publish(config, [cycleBlock(1000)]);
  assert.equal(messages.length, 1);
});

test("test mode publishes every FB on every round and disabling it restores change detection", async () => {
  const { publish, messages } = recordingPublisher();
  const blocks = [cycleBlock(1000), cycleBlock(1000, 58, "fb/2")];
  await publish(config, blocks);
  await publish({ ...config, testMode: true }, blocks);
  blocks[0].values.cycle_counter = 42;
  blocks[1] = cycleBlock(2000, 58, "fb/2");
  await publish({ ...config, testMode: true }, blocks);
  assert.deepEqual(
    messages.map((message) => message.topic),
    ["fb/1", "fb/2", "fb/1", "fb/2", "fb/1", "fb/2"],
  );
  assert.equal(messages[4].values.cycle_counter, 42);
  assert.equal(messages[5].values.timestamp_DI_IPos_ON, 2110);
  assert.equal(messages[4].values.isThisAutomaticMode, true);
  assert.equal(messages[5].values.isThisAutomaticMode, true);

  await publish({ ...config, testMode: false }, blocks);
  assert.equal(messages.length, 6);
  blocks[0] = cycleBlock(3000, 0, "fb/1");
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
  assert.equal(await publish({ ...config, testMode: true }, [cycleBlock(1000)]), false);
  delivered = true;
  assert.equal(await publish({ ...config, testMode: false }, [cycleBlock(1000)]), true);
  await publish({ ...config, testMode: false }, [cycleBlock(1000)]);
  assert.equal(attempts, 2);
});

test("tracks 66 heterogeneous cylinders independently and publishes concurrently", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const deliveredTopics = [];
  const publish = createModbusDatablockPublisher(async (_mqtt, topic) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(10);
    inFlight--;
    deliveredTopics.push(topic);
    return true;
  });

  // 66 cylinders: 60 valid complete cycles, 6 mid-stroke torn cylinders
  const round1 = Array.from({ length: 66 }, (_, i) => {
    const b = cycleBlock(1000 + i * 5, i * 58, `cyl/${i + 1}`, { cycle_counter: 1 });
    if (i >= 60) {
      // Mid-stroke: retract not completed yet (EPos_OFF > IPos_ON)
      b.values.timestamp_DI_IPos_ON = String(1000 + i * 5 + 70);
    }
    return b;
  });

  const startedAt = Date.now();
  assert.equal(await publish(config, round1), true);
  const elapsed = Date.now() - startedAt;

  assert.equal(deliveredTopics.length, 60, "only the 60 complete cycles should publish");
  assert.ok(maxInFlight > 1, `expected concurrent MQTT publishing, saw maxInFlight=${maxInFlight}`);
  assert.ok(elapsed < 250, `expected concurrent batch under 250ms, took ${elapsed}ms`);

  // Round 2: cylinders 0..9 advance fast, cylinders 60..65 finish their slow cycle, 10..59 idle
  deliveredTopics.length = 0;
  const round2 = round1.map((b, i) => {
    if (i < 10) return cycleBlock(5000 + i * 5, i * 58, `cyl/${i + 1}`, { cycle_counter: 2 });
    if (i >= 60) return cycleBlock(1000 + i * 5, i * 58, `cyl/${i + 1}`, { cycle_counter: 1 });
    return b;
  });
  assert.equal(await publish(config, round2), true);
  assert.equal(deliveredTopics.length, 16);
});

test("custom layout mode with standard cylinder timestamps enforces cycle consistency while preserving payload", async () => {
  const { publish, messages } = recordingPublisher();
  const customConfig = { ...config, layoutMode: "custom" };
  const customBlock = (base, extra = {}) => ({
    startAddress: 0,
    topic: "custom/cyl/1",
    values: {
      ...cycleBlock(base).values,
      udiCycleCounter: 1,
      sPartnumber: "CYL-001",
      ...extra,
    },
  });

  // Valid cycle 1 publishes exact custom payload (timestamps remain strings, no isThisAutomaticMode added)
  await publish(customConfig, [customBlock(1000)]);
  assert.equal(messages.length, 1);
  assert.equal(typeof messages[0].values.timestamp_DI_IPos_ON, "string");
  assert.equal(messages[0].values.isThisAutomaticMode, undefined);
  assert.equal(messages[0].values.sPartnumber, "CYL-001");

  // Unchanged is suppressed
  await publish(customConfig, [customBlock(1000)]);
  assert.equal(messages.length, 1);

  // Torn mid-stroke is suppressed
  await publish(customConfig, [customBlock(1000, { timestamp_DO_MCtrl14_ON: "2000", timestamp_DI_IPos_OFF: "2015" })]);
  assert.equal(messages.length, 1);

  // Complete cycle 2 publishes
  await publish(customConfig, [customBlock(2000, { udiCycleCounter: 2 })]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].values.udiCycleCounter, 2);
});

test("tracks FBs independently, even when their timestamps and topics match", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [cycleBlock(1000), cycleBlock(1000, 58)]);
  await publish(config, [cycleBlock(1000), cycleBlock(2000, 58, "fb/1", { cycle_counter: 12 })]);
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
  const blocks = [cycleBlock(1000), cycleBlock(1000, 58, "fb/2")];
  await assert.rejects(publish(config, blocks), /broker unavailable/);
  fail = false;
  assert.equal(await publish(config, blocks), true);
  assert.deepEqual(attempts.sort(), ["fb/1", "fb/2", "fb/2"]);
});

test("an unconfigured or unsuccessful MQTT delivery does not consume a change", async () => {
  let delivered = false;
  let attempts = 0;
  const publish = createModbusDatablockPublisher(async () => { attempts++; return delivered; });
  assert.equal(await publish(config, [cycleBlock(1000)]), false);
  delivered = true;
  assert.equal(await publish(config, [cycleBlock(1000)]), true);
  await publish(config, [cycleBlock(1000)]);
  assert.equal(attempts, 2);
});

test("polling updates preserve the baseline, while a new MQTT destination gets a snapshot", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [cycleBlock(1000)]);
  await publish({ ...config, polling: 100 }, [cycleBlock(1000)]);
  assert.equal(messages.length, 1);
  await publish({ mqtt: { ...config.mqtt, host: "new-broker" } }, [cycleBlock(1000)]);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].mqtt.host, "new-broker");
});

test("new topics and start addresses receive a snapshot; removed FBs forget their baseline", async () => {
  const { publish, messages } = recordingPublisher();
  await publish(config, [cycleBlock(1000), cycleBlock(2000, 58, "fb/2")]);
  await publish(config, [cycleBlock(1000, 0, "new/topic"), cycleBlock(2000, 58, "fb/2")]);
  assert.equal(messages.length, 3);
  await publish(config, [cycleBlock(1000, 26000, "new/topic")]);
  assert.equal(messages.length, 4);
  await publish(config, [cycleBlock(1000, 26000, "new/topic"), cycleBlock(2000, 58, "fb/2")]);
  assert.equal(messages.length, 5);
});

test("separate PLC pollers have independent baselines", async () => {
  const first = recordingPublisher();
  const second = recordingPublisher();
  await first.publish(config, [cycleBlock(1000)]);
  await second.publish(config, [cycleBlock(1000)]);
  await first.publish(config, [cycleBlock(1000)]);
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
});
