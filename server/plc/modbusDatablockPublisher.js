import { MODBUS_DATABLOCK_FIELDS } from "../../shared/modbusDatablock.js";

const DEFAULT_PUBLISH_CONCURRENCY = 32;

export const CYLINDER_CYCLE_TIMESTAMP_FIELDS = Object.freeze([
  "timestamp_DO_MCtrl14_ON",
  "timestamp_DI_IPos_OFF",
  "timestamp_DI_EPos_ON",
  "timestamp_DO_MCtrl12_ON",
  "timestamp_DI_EPos_OFF",
  "timestamp_DI_IPos_ON",
]);

const timestampFields = MODBUS_DATABLOCK_FIELDS.filter(
  (field) => field.dataType === "ULINT",
);

function parseNonNegativeBigInt(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed);
  }
  return null;
}

export function hasCylinderCycleTimestamps(values) {
  return Boolean(
    values &&
      typeof values === "object" &&
      CYLINDER_CYCLE_TIMESTAMP_FIELDS.every(
        (name) => values[name] !== undefined && values[name] !== null,
      ),
  );
}

export function extractCylinderCycleTimestamps(values) {
  if (!hasCylinderCycleTimestamps(values)) return null;
  const parsed = {};
  for (const name of CYLINDER_CYCLE_TIMESTAMP_FIELDS) {
    const bigintValue = parseNonNegativeBigInt(values[name]);
    if (bigintValue === null) return null;
    parsed[name] = bigintValue;
  }
  return parsed;
}

/**
 * Verifies that the 6 timestamps used to compute the 4 cylinder stroke
 * durations belong to one intact, non-zero, monotonically ordered cycle:
 *   t1 = DI_IPos_OFF - DO_MCtrl14_ON > 0
 *   t2 = DI_EPos_ON  - DI_IPos_OFF   > 0
 *   t3 = DI_EPos_OFF - DO_MCtrl12_ON > 0
 *   t4 = DI_IPos_ON  - DI_EPos_OFF   > 0
 * plus the intermediate dwell transition (>= 0) linking extend and retract.
 * Supports both extend-first (IPos -> EPos -> IPos) and retract-first
 * (EPos -> IPos -> EPos) cylinders regardless of individual stroke speed.
 */
export function isConsistentCylinderCycle(timestamps) {
  if (!timestamps) return false;
  const {
    timestamp_DO_MCtrl14_ON: t14On,
    timestamp_DI_IPos_OFF: tIPosOff,
    timestamp_DI_EPos_ON: tEPosOn,
    timestamp_DO_MCtrl12_ON: t12On,
    timestamp_DI_EPos_OFF: tEPosOff,
    timestamp_DI_IPos_ON: tIPosOn,
  } = timestamps;

  if (
    t14On <= 0n ||
    tIPosOff <= 0n ||
    tEPosOn <= 0n ||
    t12On <= 0n ||
    tEPosOff <= 0n ||
    tIPosOn <= 0n
  ) {
    return false;
  }

  const extendFirst =
    t14On < tIPosOff &&
    tIPosOff < tEPosOn &&
    tEPosOn <= t12On &&
    t12On < tEPosOff &&
    tEPosOff < tIPosOn;

  const retractFirst =
    t12On < tEPosOff &&
    tEPosOff < tIPosOn &&
    tIPosOn <= t14On &&
    t14On < tIPosOff &&
    tIPosOff < tEPosOn;

  return extendFirst || retractFirst;
}

/**
 * Ensures all 6 timestamps moved to a new cycle together (either all advanced
 * strictly forward, or all reset together after a PLC restart/clock reset).
 * Partial/torn updates where only a subset of registers changed are rejected.
 */
export function hasCycleProgressed(previous, current) {
  if (!previous) return true;
  let allAdvanced = true;
  let allReset = true;
  for (const name of CYLINDER_CYCLE_TIMESTAMP_FIELDS) {
    if (!(current[name] > previous[name])) allAdvanced = false;
    if (!(current[name] < previous[name])) allReset = false;
  }
  return allAdvanced || allReset;
}

function shortTimestampName(fieldName) {
  return fieldName.replace(/^timestamp_/, "");
}

function describeCycleInconsistency(timestamps) {
  const {
    timestamp_DO_MCtrl14_ON: t14On,
    timestamp_DI_IPos_OFF: tIPosOff,
    timestamp_DI_EPos_ON: tEPosOn,
    timestamp_DO_MCtrl12_ON: t12On,
    timestamp_DI_EPos_OFF: tEPosOff,
    timestamp_DI_IPos_ON: tIPosOn,
  } = timestamps;

  const problems = [];
  if (tIPosOff <= t14On) problems.push("t1 (IPos_OFF <= MCtrl14_ON)");
  if (tEPosOn <= tIPosOff) problems.push("t2 (EPos_ON <= IPos_OFF)");
  if (tEPosOff <= t12On) problems.push("t3 (EPos_OFF <= MCtrl12_ON)");
  if (tIPosOn <= tEPosOff) problems.push("t4 (IPos_ON <= EPos_OFF)");
  if (problems.length > 0) {
    return `Stroke timestamps out of order: ${problems.join(", ")}`;
  }
  return "Extend and retract strokes overlap (torn mid-cycle snapshot)";
}

function mqttPayload(values) {
  const payload = Object.fromEntries(timestampFields.map(({ name }) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} cannot be published as an exact JSON number: ${values[name]}`);
    }
    return [name, value];
  }));
  return {
    ...payload,
    cycle_counter: values.cycle_counter,
    part_number: values.part_number,
    isThisAutomaticMode: true,
  };
}

export function buildDatablockMqttPayload(values, { isCustom = false } = {}) {
  return isCustom ? values : mqttPayload(values);
}

/**
 * Evaluates a datablock against the Connector's normal-mode publish standard
 * (safe JSON timestamps, all 6 cycle timestamps > 0, monotonic cycle order,
 * and full 6-timestamp progression vs the last published cycle).
 */
export function evaluateDatablockPublishGate(
  values,
  previousCycle = null,
  { isCustom = false } = {},
) {
  if (!values || typeof values !== "object") {
    return {
      enforced: true,
      eligible: false,
      consistent: false,
      progressed: false,
      reason: "NO_VALUES",
      detail: "No datablock values available",
      cycle: null,
      zeroFields: [],
      changedTimestampFields: [],
      unchangedTimestampFields: [],
    };
  }

  try {
    buildDatablockMqttPayload(values, { isCustom });
  } catch (error) {
    return {
      enforced: true,
      eligible: false,
      consistent: false,
      progressed: false,
      reason: "PAYLOAD_ERROR",
      detail: error instanceof Error ? error.message : String(error),
      cycle: null,
      zeroFields: [],
      changedTimestampFields: [],
      unchangedTimestampFields: [],
    };
  }

  const enforceCycleGating = !isCustom || hasCylinderCycleTimestamps(values);
  if (!enforceCycleGating) {
    return {
      enforced: false,
      eligible: true,
      consistent: true,
      progressed: true,
      reason: "NO_CYCLE_GATING",
      detail: "Custom layout without 6 cylinder timestamps",
      cycle: null,
      zeroFields: [],
      changedTimestampFields: [],
      unchangedTimestampFields: [],
    };
  }

  const zeroFields = [];
  const invalidFields = [];
  const parsed = {};
  for (const name of CYLINDER_CYCLE_TIMESTAMP_FIELDS) {
    const bigintValue = parseNonNegativeBigInt(values[name]);
    if (bigintValue === null) {
      invalidFields.push(shortTimestampName(name));
    } else if (bigintValue <= 0n) {
      zeroFields.push(shortTimestampName(name));
    } else {
      parsed[name] = bigintValue;
    }
  }

  if (invalidFields.length > 0) {
    return {
      enforced: true,
      eligible: false,
      consistent: false,
      progressed: false,
      reason: "INVALID_TIMESTAMPS",
      detail: `Invalid timestamp values: ${invalidFields.join(", ")}`,
      cycle: null,
      zeroFields,
      changedTimestampFields: [],
      unchangedTimestampFields: [],
    };
  }

  if (zeroFields.length > 0) {
    return {
      enforced: true,
      eligible: false,
      consistent: false,
      progressed: false,
      reason: "ZERO_TIMESTAMPS",
      detail:
        zeroFields.length === CYLINDER_CYCLE_TIMESTAMP_FIELDS.length
          ? "All 6 cycle timestamps are 0 (uninitialized)"
          : `${zeroFields.length}/6 cycle timestamps are 0: ${zeroFields.join(", ")}`,
      cycle: null,
      zeroFields,
      changedTimestampFields: [],
      unchangedTimestampFields: [],
    };
  }

  if (!isConsistentCylinderCycle(parsed)) {
    return {
      enforced: true,
      eligible: false,
      consistent: false,
      progressed: false,
      reason: "INCONSISTENT_CYCLE",
      detail: describeCycleInconsistency(parsed),
      cycle: parsed,
      zeroFields: [],
      changedTimestampFields: [],
      unchangedTimestampFields: [],
    };
  }

  if (previousCycle) {
    const advancedFields = [];
    const regressedFields = [];
    const unchangedFields = [];
    for (const name of CYLINDER_CYCLE_TIMESTAMP_FIELDS) {
      if (parsed[name] > previousCycle[name]) advancedFields.push(shortTimestampName(name));
      else if (parsed[name] < previousCycle[name]) regressedFields.push(shortTimestampName(name));
      else unchangedFields.push(shortTimestampName(name));
    }
    const allAdvanced = advancedFields.length === CYLINDER_CYCLE_TIMESTAMP_FIELDS.length;
    const allReset = regressedFields.length === CYLINDER_CYCLE_TIMESTAMP_FIELDS.length;

    if (!allAdvanced && !allReset) {
      if (unchangedFields.length === CYLINDER_CYCLE_TIMESTAMP_FIELDS.length) {
        return {
          enforced: true,
          eligible: false,
          consistent: true,
          progressed: false,
          reason: "CYCLE_NOT_PROGRESSED",
          detail: "All 6 cycle timestamps match the last published cycle",
          cycle: parsed,
          zeroFields: [],
          changedTimestampFields: [],
          unchangedTimestampFields: unchangedFields,
        };
      }
      const changedTimestampFields = [...advancedFields, ...regressedFields];
      return {
        enforced: true,
        eligible: false,
        consistent: true,
        progressed: false,
        reason: "PARTIAL_TIMESTAMP_PROGRESSION",
        detail: `Only ${changedTimestampFields.length}/6 timestamps changed (${changedTimestampFields.join(", ")}); waiting for all 6 to advance together`,
        cycle: parsed,
        zeroFields: [],
        changedTimestampFields,
        unchangedTimestampFields: unchangedFields,
      };
    }
  }

  return {
    enforced: true,
    eligible: true,
    consistent: true,
    progressed: true,
    reason: "VALID_CYCLE",
    detail: "Complete monotonic 6-timestamp cycle",
    cycle: parsed,
    zeroFields: [],
    changedTimestampFields: [],
    unchangedTimestampFields: [],
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

// Keep the last successfully delivered cycle timestamps separately for every FB/DB.
export function createModbusDatablockPublisher(
  publishPayload,
  { concurrency = DEFAULT_PUBLISH_CONCURRENCY, onRoundEvaluated } = {},
) {
  const lastPublished = new Map();
  let destination;

  const blockKey = (block) => JSON.stringify([block.startAddress, block.topic]);

  const publish = async (config, dataBlocks) => {
    const nextDestination = JSON.stringify(
      ["protocol", "host", "port", "username", "password", "clientId", "qos"].map(
        (key) => config.mqtt?.[key],
      ),
    );
    if (nextDestination !== destination) {
      lastPublished.clear();
      destination = nextDestination;
    }

    const activeKeys = new Set(dataBlocks.map(blockKey));
    for (const key of lastPublished.keys()) {
      if (!activeKeys.has(key)) lastPublished.delete(key);
    }

    const isCustom = config.layoutMode === "custom";
    const isTestMode = config.testMode === true;
    const tasks = [];
    const errors = [];
    const roundReports = new Map();

    for (const block of dataBlocks) {
      const key = blockKey(block);
      const previousCycle = lastPublished.get(key) ?? null;
      const gate = evaluateDatablockPublishGate(block.values, previousCycle, { isCustom });
      let payload;
      try {
        payload = buildDatablockMqttPayload(block.values, { isCustom });
      } catch (error) {
        roundReports.set(key, {
          gate,
          attempted: false,
          delivered: false,
          error: error instanceof Error ? error.message : String(error),
        });
        errors.push(error);
        continue;
      }

      if (gate.enforced && !isTestMode && !gate.eligible) {
        roundReports.set(key, {
          gate,
          attempted: false,
          delivered: false,
          error: null,
        });
        continue;
      }

      roundReports.set(key, {
        gate,
        attempted: true,
        delivered: false,
        error: null,
      });

      tasks.push({
        key,
        topic: block.topic,
        payload,
        cycle: gate.consistent ? gate.cycle : null,
      });
    }

    if (tasks.length === 0) {
      if (typeof onRoundEvaluated === "function") onRoundEvaluated(roundReports);
      if (errors.length > 0) throw errors[0];
      return lastPublished.size > 0 || Boolean(config.mqtt?.host);
    }

    let published = true;
    await runWithConcurrency(tasks, concurrency, async (task) => {
      const report = roundReports.get(task.key);
      try {
        const delivered = await publishPayload(config.mqtt, task.topic, task.payload);
        if (delivered) {
          if (report) report.delivered = true;
          if (task.cycle) lastPublished.set(task.key, task.cycle);
        } else {
          published = false;
        }
      } catch (error) {
        published = false;
        if (report) report.error = error instanceof Error ? error.message : String(error);
        errors.push(error);
      }
    });

    if (typeof onRoundEvaluated === "function") onRoundEvaluated(roundReports);
    if (errors.length > 0) throw errors[0];
    return published;
  };

  publish.getLastPublishedCycle = (block) => lastPublished.get(blockKey(block)) ?? null;
  return publish;
}
