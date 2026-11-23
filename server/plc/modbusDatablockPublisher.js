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
  { concurrency = DEFAULT_PUBLISH_CONCURRENCY } = {},
) {
  const lastPublished = new Map();
  let destination;

  return async (config, dataBlocks) => {
    const nextDestination = JSON.stringify(
      ["protocol", "host", "port", "username", "password", "clientId", "qos"].map(
        (key) => config.mqtt?.[key],
      ),
    );
    if (nextDestination !== destination) {
      lastPublished.clear();
      destination = nextDestination;
    }

    const blockKey = (block) => JSON.stringify([block.startAddress, block.topic]);
    const activeKeys = new Set(dataBlocks.map(blockKey));
    for (const key of lastPublished.keys()) {
      if (!activeKeys.has(key)) lastPublished.delete(key);
    }

    const isCustom = config.layoutMode === "custom";
    const isTestMode = config.testMode === true;
    const tasks = [];
    const errors = [];

    for (const block of dataBlocks) {
      const key = blockKey(block);
      let payload;
      try {
        payload = isCustom ? block.values : mqttPayload(block.values);
      } catch (error) {
        errors.push(error);
        continue;
      }

      const enforceCycleGating = !isCustom || hasCylinderCycleTimestamps(block.values);
      const cycle = enforceCycleGating
        ? extractCylinderCycleTimestamps(block.values)
        : null;
      const consistent = cycle !== null && isConsistentCylinderCycle(cycle);

      if (enforceCycleGating && !isTestMode) {
        if (!consistent) continue;
        if (!hasCycleProgressed(lastPublished.get(key), cycle)) continue;
      }

      tasks.push({
        key,
        topic: block.topic,
        payload,
        cycle: consistent ? cycle : null,
      });
    }

    if (tasks.length === 0) {
      if (errors.length > 0) throw errors[0];
      return lastPublished.size > 0 || Boolean(config.mqtt?.host);
    }

    let published = true;
    await runWithConcurrency(tasks, concurrency, async (task) => {
      try {
        const delivered = await publishPayload(config.mqtt, task.topic, task.payload);
        if (delivered) {
          if (task.cycle) lastPublished.set(task.key, task.cycle);
        } else {
          published = false;
        }
      } catch (error) {
        published = false;
        errors.push(error);
      }
    });

    if (errors.length > 0) throw errors[0];
    return published;
  };
}
