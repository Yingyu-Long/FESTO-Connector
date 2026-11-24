import { setTimeout as delay } from "node:timers/promises";
import { acquireModbusConnection } from "./modbusConnectionPool.js";
import { publishPayload } from "../mqttPublisher.js";
import { recordDiagnosticEvent } from "../debugBot/diagnosticLog.js";
import {
  buildDatablockMqttPayload,
  createModbusDatablockPublisher,
  evaluateDatablockPublishGate,
} from "./modbusDatablockPublisher.js";
import {
  modbusErrorMessage,
  normalizeModbusConfig,
  readModbusDatablocks,
  readModbusRegisters,
  readModbusSample,
} from "./modbusClient.js";

const activePollers = new Map();
const pollingStatuses = new Map();
const OFFLINE_RETRY_MIN_MS = 2000;
const OFFLINE_RETRY_MAX_MS = 10000;
const TEST_MODE_MAX_DURATION_SEC = 15;
const TEST_MODE_PUBLISH_CONCURRENCY = 32;

function sameConnection(first, second) {
  return first.host.toLowerCase() === second.host.toLowerCase() && first.port === second.port;
}

function pollerKey(plcId, namespace) { return JSON.stringify([namespace, String(plcId)]); }

function diffValueFields(previous, current) {
  if (!previous || !current || typeof previous !== "object" || typeof current !== "object") {
    return [];
  }
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const changed = [];
  for (const name of names) {
    if (JSON.stringify(previous[name]) !== JSON.stringify(current[name])) {
      changed.push(name);
    }
  }
  return changed;
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

export function listActiveModbusPollers() {
  return Array.from(activePollers.values()).map((poller) => ({
    id: poller.config.id,
    namespace: poller.namespace,
    config: poller.config,
  }));
}

export function listModbusDatablockPollers() {
  return Array.from(activePollers.values())
    .filter((poller) => poller.config.readMode === "Read by Datablocks")
    .map((poller) => {
      const status = getModbusPollerStatus(poller.config.id, poller.namespace);
      return {
        plcId: poller.config.id,
        namespace: poller.namespace,
        endpoint: `${poller.config.host}:${poller.config.port}`,
        layoutMode: poller.config.layoutMode ?? "standard",
        endian: poller.config.endian ?? "Big-Endian",
        pollingMs: poller.config.polling,
        pollingStatus: status.pollingStatus,
        blockCount:
          Array.isArray(poller.config.blockTopics) ? poller.config.blockTopics.length : 0,
        mqttConfigured: Boolean(poller.config.mqtt?.host),
      };
    });
}

export async function runModbusTestModePublish({
  plcId = null,
  durationSeconds = 0,
} = {}) {
  const candidates = Array.from(activePollers.values()).filter(
    (poller) => poller.config.readMode === "Read by Datablocks",
  );
  const targets = plcId
    ? candidates.filter((poller) => poller.config.id === String(plcId).trim())
    : candidates;

  if (targets.length === 0) {
    return {
      ok: false,
      found: false,
      durationSeconds: 0,
      availablePollers: listModbusDatablockPollers(),
      message: plcId
        ? `No active Modbus Datablock poller found with id "${plcId}".`
        : "No active Modbus 'Read by Datablocks' pollers are currently running.",
      results: [],
    };
  }

  const boundedDurationSec = Number.isFinite(Number(durationSeconds))
    ? Math.max(0, Math.min(TEST_MODE_MAX_DURATION_SEC, Math.floor(Number(durationSeconds))))
    : 0;

  const startedAt = Date.now();
  const results = await Promise.all(
    targets.map((poller) => poller.runTestModePublish({ durationSeconds: boundedDurationSec })),
  );

  const totalPublished = results.reduce((sum, item) => sum + item.publishedCount, 0);
  const totalFailed = results.reduce((sum, item) => sum + item.failedCount, 0);
  const anyReadOk = results.some((item) => item.readOk);

  return {
    ok: anyReadOk && totalFailed === 0,
    found: true,
    durationSeconds: boundedDurationSec,
    elapsedMs: Date.now() - startedAt,
    totalPublished,
    totalFailed,
    availablePollers: listModbusDatablockPollers(),
    results,
  };
}

export async function updateModbusPollerMqtt(plcId, mqttConfig, namespace = "modbus") {
  const poller = activePollers.get(pollerKey(plcId, namespace));
  if (!poller) return false;
  await poller.updateMqtt(mqttConfig);
  return true;
}

export async function updateActiveModbusPollersMqtt(mqttConfig) {
  const pollers = Array.from(activePollers.values());
  await Promise.allSettled(pollers.map((poller) => poller.updateMqtt(mqttConfig)));
}

export async function stopAllModbusPollers() {
  const entries = Array.from(activePollers.values()).map((poller) => ({
    id: poller.config.id,
    namespace: poller.namespace,
  }));
  await Promise.allSettled(
    entries.map(({ id, namespace }) => stopModbusPoller(id, namespace)),
  );
}

function setPollingStatus(plcId, status, namespace = "modbus") {
  pollingStatuses.set(pollerKey(plcId, namespace), {
    plcId: String(plcId),
    updatedAt: Date.now(),
    ...status,
  });
}

export function getModbusPollerStatus(plcId, namespace = "modbus") {
  return (
    pollingStatuses.get(pollerKey(plcId, namespace)) ?? {
      plcId: String(plcId),
      updatedAt: null,
      pollingStatus: "NOT_CONNECTED",
      lastReadAt: null,
      lastReadError: null,
      lastPublishError: null,
      consecutiveReadErrors: 0,
      registers: [],
      dataBlocks: [],
    }
  );
}

export async function stopModbusPoller(plcId, namespace = "modbus") {
  const key = pollerKey(plcId, namespace);
  const poller = activePollers.get(key);
  if (!poller) return;

  await poller.stop();
  if (activePollers.get(key) !== poller) return;
  activePollers.delete(key);
  const prev = getModbusPollerStatus(plcId, namespace);
  setPollingStatus(plcId, {
    pollingStatus: "NOT_CONNECTED",
    lastReadAt: prev.lastReadAt ?? null,
    lastReadError: prev.lastReadError ?? null,
    lastPublishError: prev.lastPublishError ?? null,
    consecutiveReadErrors: prev.consecutiveReadErrors ?? 0,
    registers: prev.registers,
    dataBlocks: prev.dataBlocks,
  }, namespace);
}

export async function testModbusPollerConnection(rawConfig) {
  const config = normalizeModbusConfig(rawConfig);
  const connection = acquireModbusConnection(config);
  try {
    return await connection.run(config, (client) => readModbusSample(client, config));
  } finally {
    await connection.release();
  }
}

export async function startModbusPoller(rawConfig, namespace = "modbus", options = {}) {
  // Validate before touching any running acquisition.
  let config = normalizeModbusConfig(rawConfig);
  const { keepAliveOnInitialError = false, retryIntervalMs } = options;
  const key = pollerKey(config.id, namespace);
  const getStatus = () => getModbusPollerStatus(config.id, namespace);
  const setStatus = (status) => setPollingStatus(config.id, status, namespace);
  const existing = activePollers.get(key);
  if (existing && sameConnection(existing.config, config)) {
    return existing.update(config, options);
  }
  await stopModbusPoller(config.id, namespace);

  const connection = acquireModbusConnection(config);
  let timer;
  let stopped = false;
  let operationQueue = Promise.resolve();
  let stopPromise;
  let latestRoundReports = new Map();
  let lastReadAt = null;
  let lastReadError = null;
  let lastPublishError = null;
  let consecutiveReadErrors = 0;

  const createPublisher = () =>
    createModbusDatablockPublisher(publishPayload, {
      onRoundEvaluated: (reports) => {
        latestRoundReports = reports;
      },
    });
  let publishDatablocks = createPublisher();
  const blockFreshness = new Map();

  const enrichBlockFreshness = (blocks, observedAt, roundReports) => {
    const activeKeys = new Set();
    const isCustom = config.layoutMode === "custom";
    const enriched = blocks.map((block) => {
      const bKey = JSON.stringify([block.startAddress, block.topic]);
      activeKeys.add(bKey);
      const fingerprint = JSON.stringify(block.values ?? null);
      const report = roundReports?.get(bKey) ?? null;

      let entry = blockFreshness.get(bKey);
      const isInitial = !entry;
      let rawChangedThisPoll = false;

      const needsLocalCycleCheck =
        !isInitial &&
        Boolean(entry?.lastAcceptedCycle) &&
        (!report?.gate || (!report.delivered && report.gate.reason === "VALID_CYCLE"));
      const gate = needsLocalCycleCheck
        ? evaluateDatablockPublishGate(block.values, entry.lastAcceptedCycle, { isCustom })
        : (report?.gate ??
            evaluateDatablockPublishGate(
              block.values,
              isInitial ? null : (entry?.lastAcceptedCycle ?? null),
              { isCustom },
            ));

      if (!entry) {
        entry = {
          fingerprint,
          lastValues: structuredClone(block.values ?? null),
          baselineValidValues: structuredClone(block.values ?? null),
          lastAcceptedCycle: gate.consistent ? gate.cycle : null,
          firstSeenAt: observedAt,
          lastDataUpdatedAt: null,
          updateCount: 0,
          lastValidCycleAt: null,
          validCycleCount: 0,
          lastPublishedAt: report?.delivered ? observedAt : null,
          publishCount: report?.delivered ? 1 : 0,
          lastRejectedChangeAt: null,
          rejectedChangeCount: 0,
          changedFieldsSinceValid: [],
          publishGate: null,
        };
        blockFreshness.set(bKey, entry);
      } else {
        if (entry.fingerprint !== fingerprint) {
          rawChangedThisPoll = true;
          entry.fingerprint = fingerprint;
          entry.lastValues = structuredClone(block.values ?? null);
          entry.lastDataUpdatedAt = observedAt;
          entry.updateCount += 1;
        }
        if (report?.delivered) {
          entry.lastPublishedAt = observedAt;
          entry.publishCount += 1;
        }
      }

      const gateSummary = {
        enforced: gate.enforced,
        eligible: gate.eligible,
        consistent: gate.consistent,
        progressed: gate.progressed,
        reason: gate.reason,
        detail: gate.detail,
        zeroFields: gate.zeroFields ?? [],
        changedTimestampFields: gate.changedTimestampFields ?? [],
        unchangedTimestampFields: gate.unchangedTimestampFields ?? [],
      };
      entry.publishGate = gateSummary;

      if (!isInitial) {
        const passedNewCycle = gate.enforced
          ? rawChangedThisPoll && Boolean(gate.eligible)
          : rawChangedThisPoll;
        if (passedNewCycle) {
          entry.lastAcceptedCycle = gate.consistent ? gate.cycle : entry.lastAcceptedCycle;
          entry.lastValidCycleAt = observedAt;
          entry.validCycleCount += 1;
          entry.baselineValidValues = structuredClone(block.values ?? null);
          entry.lastRejectedChangeAt = null;
          entry.changedFieldsSinceValid = [];
        } else if (rawChangedThisPoll) {
          // Raw Modbus data changed on this poll, but the publish standard rejected it.
          entry.lastRejectedChangeAt = observedAt;
          entry.rejectedChangeCount += 1;
          entry.changedFieldsSinceValid = diffValueFields(
            entry.baselineValidValues,
            block.values,
          );
        }
      }

      return {
        ...block,
        firstSeenAt: entry.firstSeenAt,
        lastDataUpdatedAt: entry.lastDataUpdatedAt,
        updateCount: entry.updateCount,
        lastRawChangedAt: entry.lastDataUpdatedAt,
        rawChangeCount: entry.updateCount,
        lastValidCycleAt: entry.lastValidCycleAt,
        validCycleCount: entry.validCycleCount,
        lastPublishedAt: entry.lastPublishedAt,
        publishCount: entry.publishCount,
        lastRejectedChangeAt: entry.lastRejectedChangeAt,
        rejectedChangeCount: entry.rejectedChangeCount,
        changedFieldsSinceValid: entry.changedFieldsSinceValid,
        publishGate: entry.publishGate,
      };
    });
    for (const existingKey of blockFreshness.keys()) {
      if (!activeKeys.has(existingKey)) blockFreshness.delete(existingKey);
    }
    return enriched;
  };

  const runExclusive = (operation) => {
    const result = operationQueue.then(() => {
      if (stopped) {
        throw new Error("Modbus polling has stopped; retry the connection test");
      }
      return operation();
    });
    // A failed test must not prevent subsequent polling or tests.
    operationQueue = result.catch(() => undefined);
    return result;
  };

  const readAndPublish = async () => {
    if (config.readMode === "Read by Datablocks") {
      let rawBlocks;
      try {
        rawBlocks = await connection.run(config, (client) => readModbusDatablocks(client, config));
        lastReadAt = Date.now();
        lastReadError = null;
        consecutiveReadErrors = 0;
      } catch (error) {
        lastReadError = modbusErrorMessage(error);
        consecutiveReadErrors += 1;
        throw error;
      }

      latestRoundReports = new Map();
      let published = false;
      let publishErr = null;
      try {
        published = await publishDatablocks(config, rawBlocks);
        lastPublishError = null;
      } catch (error) {
        publishErr = error;
        lastPublishError = modbusErrorMessage(error);
      }

      const dataBlocks = enrichBlockFreshness(rawBlocks, lastReadAt, latestRoundReports);
      const topics = dataBlocks.map((block) => block.topic);

      if (publishErr) {
        setStatus({
          pollingStatus: "UNHEALTHY",
          lastReadAt,
          lastReadError: null,
          lastPublishError,
          consecutiveReadErrors: 0,
          mqttTopics: topics,
          registers: [],
          dataBlocks,
          error: lastPublishError,
        });
        throw publishErr;
      }

      setStatus({
        pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
        lastReadAt,
        lastReadError: null,
        lastPublishError: null,
        consecutiveReadErrors: 0,
        mqttTopics: topics,
        registers: [],
        dataBlocks,
      });
      return { registers: [], dataBlocks, published, topics };
    }

    let registers;
    try {
      registers = await connection.run(config, (client) => readModbusRegisters(client, config.registers));
      lastReadAt = Date.now();
      lastReadError = null;
      consecutiveReadErrors = 0;
    } catch (error) {
      lastReadError = modbusErrorMessage(error);
      consecutiveReadErrors += 1;
      throw error;
    }

    const timestamp = new Date().toISOString();
    const payload = {
      plcId: config.id,
      protocol: "modbus.tcp",
      unitId: config.unitId,
      timestamp,
      values: Object.fromEntries(
        registers.map((register) => [register.name, register.value]),
      ),
      registers,
    };
    const topic = config.mqttTopic || `festo/plc/${config.id}`;
    let published;
    try {
      published = await publishPayload(config.mqtt, topic, payload);
      lastPublishError = null;
    } catch (error) {
      lastPublishError = modbusErrorMessage(error);
      throw error;
    }
    setStatus({
      pollingStatus: published ? "HEALTHY" : "MQTT_NOT_CONFIGURED",
      lastReadAt,
      lastReadError: null,
      lastPublishError: null,
      consecutiveReadErrors: 0,
      mqttTopic: topic,
      registers,
      dataBlocks: [],
    });
    return { registers, published, topic };
  };

  const runSingleTestModeRound = async () => {
    const roundStartedAt = Date.now();
    const isCustom = config.layoutMode === "custom";
    const mqttConfigured = Boolean(config.mqtt?.host);
    const brokerUrl = mqttConfigured
      ? `${config.mqtt.protocol || "tcp://"}${config.mqtt.host}:${config.mqtt.port || 1883}`
      : null;

    let rawBlocks;
    try {
      rawBlocks = await connection.run(config, (client) => readModbusDatablocks(client, config));
    } catch (error) {
      const readError = modbusErrorMessage(error);
      return {
        readOk: false,
        readLatencyMs: Date.now() - roundStartedAt,
        readError,
        mqttConfigured,
        brokerUrl,
        publishedCount: 0,
        failedCount: Array.isArray(config.blockTopics) ? config.blockTopics.length : 0,
        blocks: [],
      };
    }

    const readLatencyMs = Date.now() - roundStartedAt;
    const blockResults = rawBlocks.map((block, idx) => {
      const previousCycle = publishDatablocks.getLastPublishedCycle?.(block) ?? null;
      const gate = evaluateDatablockPublishGate(block.values, previousCycle, { isCustom });
      let payload = null;
      let payloadError = null;
      try {
        payload = buildDatablockMqttPayload(block.values, { isCustom });
      } catch (error) {
        payloadError = error instanceof Error ? error.message : String(error);
      }
      return {
        blockIndex: block.index ?? idx,
        startAddress: block.startAddress,
        topic: block.topic,
        partNumber: block.values?.part_number ?? block.values?.sPartnumber ?? null,
        cycleCounter: block.values?.cycle_counter ?? block.values?.udiCycleCounter ?? null,
        published: false,
        publishError: payloadError,
        normalGatePassed: gate.eligible,
        normalGateReason: gate.reason,
        normalGateDetail: gate.detail,
        payload,
      };
    });

    const publishable = blockResults.filter((item) => item.payload !== null && !item.publishError);
    await runWithConcurrency(publishable, TEST_MODE_PUBLISH_CONCURRENCY, async (item) => {
      if (!mqttConfigured) {
        item.published = false;
        item.publishError = "MQTT broker is not configured";
        return;
      }
      try {
        const delivered = await publishPayload(config.mqtt, item.topic, item.payload);
        item.published = Boolean(delivered);
        if (!delivered) {
          item.publishError = "MQTT publish returned false";
        }
      } catch (error) {
        item.published = false;
        item.publishError = error instanceof Error ? error.message : String(error);
      }
    });

    const publishedCount = blockResults.filter((item) => item.published).length;
    const failedCount = blockResults.length - publishedCount;
    return {
      readOk: true,
      readLatencyMs,
      readError: null,
      mqttConfigured,
      brokerUrl,
      publishedCount,
      failedCount,
      blocks: blockResults,
    };
  };

  const schedulePoll = (startedAt, unhealthy = false) => {
    clearTimeout(timer);
    if (stopped) return;
    if (unhealthy) {
      const retryDelay = Number.isFinite(retryIntervalMs)
        ? Math.max(10, retryIntervalMs)
        : Math.min(Math.max(config.polling, OFFLINE_RETRY_MIN_MS), OFFLINE_RETRY_MAX_MS);
      timer = setTimeout(poll, retryDelay);
      return;
    }
    const elapsed = startedAt ? Date.now() - startedAt : 0;
    const delayMs = Math.max(10, config.polling - elapsed);
    timer = setTimeout(poll, delayMs);
  };

  const poll = async () => {
    if (stopped) return;
    const startedAt = Date.now();
    let failed = false;

    try {
      await runExclusive(async () => {
        try {
          await readAndPublish();
        } catch (error) {
          failed = true;
          const message = modbusErrorMessage(error);
          const prev = getStatus();
          setStatus({
            pollingStatus: "UNHEALTHY",
            lastReadAt,
            lastReadError,
            lastPublishError,
            consecutiveReadErrors,
            registers: prev.registers,
            dataBlocks: prev.dataBlocks,
            error: message,
          });
          recordDiagnosticEvent({
            level: "error",
            component: "modbus",
            plcId: config.id,
            message: `Modbus polling failed: ${message}`,
          });
          console.error(`Modbus PLC ${config.id} polling failed`, error);
        }
      });
    } catch (error) {
      failed = true;
      if (!stopped) console.error(`Modbus PLC ${config.id} polling failed`, error);
    } finally {
      schedulePoll(startedAt, failed);
    }
  };

  const poller = {
    get config() { return config; },
    get namespace() { return namespace; },
    update: (nextConfig, updateOptions = {}) => runExclusive(async () => {
      if (
        config.readMode !== nextConfig.readMode ||
        (config.layoutMode ?? "standard") !== (nextConfig.layoutMode ?? "standard") ||
        config.endian !== nextConfig.endian ||
        JSON.stringify(config.fields ?? null) !== JSON.stringify(nextConfig.fields ?? null)
      ) {
        publishDatablocks = createPublisher();
        blockFreshness.clear();
      }
      config = nextConfig;
      let failed = false;
      try {
        // Saving changes the polling configuration, not the TCP connection.
        return { connected: true, ...await readAndPublish() };
      } catch (error) {
        failed = true;
        const message = modbusErrorMessage(error);
        // The saved configuration stays active even when its first read fails.
        setStatus({
          pollingStatus: "UNHEALTHY",
          lastReadAt,
          lastReadError,
          lastPublishError,
          consecutiveReadErrors,
          registers: [],
          dataBlocks: [],
          error: message,
        });
        if (updateOptions.keepAliveOnInitialError) {
          return { connected: false, retrying: true, error: message };
        }
        throw error;
      } finally {
        schedulePoll(undefined, failed);
      }
    }),
    updateMqtt: (nextMqtt) => runExclusive(async () => {
      config = { ...config, mqtt: nextMqtt };
      if (["UNHEALTHY", "MQTT_NOT_CONFIGURED"].includes(getStatus().pollingStatus)) {
        clearTimeout(timer);
        if (!stopped) timer = setTimeout(poll, 50);
      }
    }),
    test: (testConfig) => runExclusive(async () => {
      return connection.run(testConfig, (client) => readModbusSample(client, testConfig));
    }),
    runTestModePublish: async ({ durationSeconds = 0 } = {}) => {
      const deadline = durationSeconds > 0 ? Date.now() + durationSeconds * 1000 : 0;
      const intervalMs = Math.max(250, Math.min(config.polling || 500, 2000));
      let rounds = 0;
      let totalPublished = 0;
      let totalFailed = 0;
      let latestRound = null;

      while (!stopped) {
        const roundStart = Date.now();
        latestRound = await runExclusive(runSingleTestModeRound);
        rounds += 1;
        totalPublished += latestRound.publishedCount;
        totalFailed += latestRound.failedCount;
        if (!latestRound.readOk || durationSeconds <= 0) break;
        const remaining = deadline - Date.now();
        if (remaining <= 80) break;
        const waitMs = Math.min(remaining, Math.max(50, intervalMs - (Date.now() - roundStart)));
        await delay(waitMs);
      }

      const blocks = latestRound?.blocks ?? [];
      return {
        plcId: config.id,
        namespace,
        endpoint: `${config.host}:${config.port}`,
        layoutMode: config.layoutMode ?? "standard",
        endian: config.endian ?? "Big-Endian",
        mqttConfigured: latestRound?.mqttConfigured ?? Boolean(config.mqtt?.host),
        brokerUrl: latestRound?.brokerUrl ?? null,
        readOk: latestRound?.readOk ?? false,
        readLatencyMs: latestRound?.readLatencyMs ?? null,
        readError: latestRound?.readError ?? null,
        rounds,
        totalBlocks: blocks.length,
        publishedCount: totalPublished,
        failedCount: totalFailed,
        blockedInNormalCount: blocks.filter((b) => !b.normalGatePassed).length,
        blocks,
      };
    },
    stop: () => {
      if (!stopPromise) {
        stopped = true;
        clearTimeout(timer);
        // Let an in-flight read finish before closing its socket.
        stopPromise = operationQueue.then(() => connection.release());
      }
      return stopPromise;
    },
  };
  // Register before the first read so a concurrent test also joins the queue.
  activePollers.set(key, poller);
  try {
    const result = await runExclusive(readAndPublish);
    schedulePoll();
    return { connected: true, ...result };
  } catch (error) {
    const message = modbusErrorMessage(error);
    if (keepAliveOnInitialError) {
      setStatus({
        pollingStatus: "UNHEALTHY",
        lastReadAt,
        lastReadError,
        lastPublishError,
        consecutiveReadErrors,
        registers: [],
        dataBlocks: [],
        error: message,
      });
      schedulePoll(undefined, true);
      return { connected: false, retrying: true, error: message };
    }
    await poller.stop();
    if (activePollers.get(key) === poller) {
      activePollers.delete(key);
      setStatus({
        pollingStatus: "UNHEALTHY",
        lastReadAt,
        lastReadError,
        lastPublishError,
        consecutiveReadErrors,
        registers: [],
        dataBlocks: [],
        error: message,
      });
    }
    throw error;
  }
}
