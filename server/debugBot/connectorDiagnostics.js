import net from "node:net";
import mqtt from "mqtt";
import { query as defaultQuery } from "../database.js";
import { getMqttPublisherStats, testMqttConnection } from "../mqttPublisher.js";
import {
  extractModbusSourcesFromConfiguration,
  extractMqttConfigFromConfiguration,
} from "../plc/modbusBootstrap.js";
import {
  getModbusPollerStatus,
  listActiveModbusPollers,
  testModbusPollerConnection,
} from "../plc/modbusPoller.js";
import { getCustomisedModbusPollerStatus } from "../plc/modbusCustomisedPoller.js";
import {
  CYLINDER_CYCLE_TIMESTAMP_FIELDS,
  evaluateDatablockPublishGate,
  extractCylinderCycleTimestamps,
  isConsistentCylinderCycle,
} from "../plc/modbusDatablockPublisher.js";
import { getSiemensPollerStatus } from "../plc/poller.js";
import { getOpcuaPollerStatus, listActiveOpcuaPollers } from "../plc/opcuaPoller.js";
import { browseOpcuaNodes, testOpcuaConnection } from "../plc/opcuaClient.js";
import {
  MODBUS_DATABLOCK_REGISTER_COUNT,
  MODBUS_MAX_READ_REGISTERS,
} from "../../shared/modbusDatablock.js";
import {
  buildCustomisedLayout,
  CUSTOMISED_PROTOCOL,
} from "../../shared/modbusCustomised.js";
import { isValidMqttPublishTopic } from "../../shared/mqttTopic.js";
import { getRecentDiagnosticEvents } from "./diagnosticLog.js";

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clamp(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

export function computeCylinderCycleMetrics(values) {
  const ts = extractCylinderCycleTimestamps(values);
  if (!ts) {
    return {
      hasCycleTimestamps: false,
      consistent: false,
      allZero: false,
      durationsMs: null,
      issues: [],
    };
  }

  const allZero = CYLINDER_CYCLE_TIMESTAMP_FIELDS.every((f) => ts[f] === 0n);
  const zeroFields = CYLINDER_CYCLE_TIMESTAMP_FIELDS.filter((f) => ts[f] === 0n);
  const unsafeFields = CYLINDER_CYCLE_TIMESTAMP_FIELDS.filter(
    (f) => ts[f] > BigInt(Number.MAX_SAFE_INTEGER),
  );

  const t1 = ts.timestamp_DI_IPos_OFF - ts.timestamp_DO_MCtrl14_ON;
  const t2 = ts.timestamp_DI_EPos_ON - ts.timestamp_DI_IPos_OFF;
  const t3 = ts.timestamp_DI_EPos_OFF - ts.timestamp_DO_MCtrl12_ON;
  const t4 = ts.timestamp_DI_IPos_ON - ts.timestamp_DI_EPos_OFF;
  const dwellExtendToRetract = ts.timestamp_DO_MCtrl12_ON - ts.timestamp_DI_EPos_ON;
  const dwellRetractToExtend = ts.timestamp_DO_MCtrl14_ON - ts.timestamp_DI_IPos_ON;

  const consistent = unsafeFields.length === 0 && isConsistentCylinderCycle(ts);
  const issues = [];
  if (unsafeFields.length > 0) {
    issues.push(
      `Unsafe 64-bit timestamps (> MAX_SAFE_INTEGER) on [${unsafeFields.join(", ")}] — likely Big-Endian / Little-Endian mismatch or wrong Start Address`,
    );
  } else if (allZero) {
    issues.push("All 6 cylinder cycle timestamps are 0 (uninitialized / idle PLC DB)");
  } else if (zeroFields.length > 0) {
    issues.push(`Incomplete cycle: zero timestamp(s) in [${zeroFields.join(", ")}]`);
  } else if (!consistent) {
    const negs = [];
    if (t1 <= 0n) negs.push(`t1(IPos_OFF-MCtrl14_ON)=${t1}`);
    if (t2 <= 0n) negs.push(`t2(EPos_ON-IPos_OFF)=${t2}`);
    if (t3 <= 0n) negs.push(`t3(EPos_OFF-MCtrl12_ON)=${t3}`);
    if (t4 <= 0n) negs.push(`t4(IPos_ON-EPos_OFF)=${t4}`);
    if (negs.length > 0) {
      issues.push(`Torn/mid-stroke cycle with non-positive duration(s): ${negs.join(", ")}`);
    } else {
      issues.push(
        `Cycle ordering mismatch between extend and retract (MCtrl12_ON-EPos_ON=${dwellExtendToRetract}, MCtrl14_ON-IPos_ON=${dwellRetractToExtend})`,
      );
    }
  }

  const safeNum = (v) =>
    v >= -BigInt(Number.MAX_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString();

  return {
    hasCycleTimestamps: true,
    consistent,
    allZero,
    populatedTimestamps: CYLINDER_CYCLE_TIMESTAMP_FIELDS.length - zeroFields.length,
    totalExpectedTimestamps: CYLINDER_CYCLE_TIMESTAMP_FIELDS.length,
    durationsMs:
      unsafeFields.length === 0 && !allZero
        ? {
            extendReactionMs: safeNum(t1),
            extendTravelMs: safeNum(t2),
            retractReactionMs: safeNum(t3),
            retractTravelMs: safeNum(t4),
            totalMotionMs: safeNum(t1 + t2 + t3 + t4),
          }
        : null,
    issues,
  };
}

export function probeTcpReachability(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const cleanHost = String(host ?? "").trim();
    const numericPort = Number(port);
    if (!cleanHost || !Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
      resolve({ reachable: false, latencyMs: null, error: "Invalid host or port" });
      return;
    }

    const startedAt = Date.now();
    let settled = false;
    const socket = net.createConnection({ host: cleanHost, port: numericPort });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({ reachable: true, latencyMs: Date.now() - startedAt, error: null });
    });
    socket.once("timeout", () => {
      finish({
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: `TCP timeout after ${timeoutMs}ms`,
      });
    });
    socket.once("error", (error) => {
      finish({
        reachable: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function getMqttBrokerUrl(mqttConfig) {
  const protocol = ["tcp://", "tcp:", "mqtt://", "mqtt:"].includes(mqttConfig.protocol)
    ? "mqtt://"
    : (mqttConfig.protocol ?? "mqtt://");
  return `${protocol}${mqttConfig.host}:${mqttConfig.port}`;
}

function extractTopicsForSource(source, protocol, pollerStatus) {
  const topics = new Set();
  if (Array.isArray(pollerStatus?.mqttTopics)) {
    for (const t of pollerStatus.mqttTopics) {
      if (typeof t === "string" && t.trim()) topics.add(t.trim());
    }
  }
  if (typeof pollerStatus?.mqttTopic === "string" && pollerStatus.mqttTopic.trim()) {
    topics.add(pollerStatus.mqttTopic.trim());
  }
  if (Array.isArray(pollerStatus?.dataBlocks)) {
    for (const block of pollerStatus.dataBlocks) {
      const candidate = block?.topic || block?.mqttTopic;
      if (typeof candidate === "string" && candidate.trim()) topics.add(candidate.trim());
    }
  }

  const raw = isRecord(source?.configuration)
    ? source.configuration
    : isRecord(source?.[`${protocol}Configuration`])
      ? source[`${protocol}Configuration`]
      : isRecord(source?.s7PniConfiguration)
        ? source.s7PniConfiguration
        : {};

  if (Array.isArray(raw.blockTopics)) {
    for (const entry of raw.blockTopics) {
      if (typeof entry === "string" && entry.trim()) {
        topics.add(entry.trim());
      } else if (isRecord(entry) && typeof entry.topic === "string" && entry.topic.trim()) {
        topics.add(entry.topic.trim());
      }
    }
  }
  if (Array.isArray(raw.dataBlocks)) {
    for (const block of raw.dataBlocks) {
      if (isRecord(block) && typeof block.mqttTopic === "string" && block.mqttTopic.trim()) {
        topics.add(block.mqttTopic.trim());
      }
    }
  }
  if (typeof raw.mqttTopic === "string" && raw.mqttTopic.trim()) {
    topics.add(raw.mqttTopic.trim());
  }
  if (topics.size === 0 && typeof source?.id === "string" && source.id.trim()) {
    if (protocol === "modbus.tcp" && raw.readMode !== "Read by Datablocks") {
      topics.add(`festo/plc/${source.id.trim()}`);
    }
  }
  return Array.from(topics);
}

export async function loadSavedConnectorConfiguration(queryFn = defaultQuery) {
  const result = await queryFn(
    `
    SELECT id, configuration, updated_at
    FROM public.connector_configurations
    ORDER BY updated_at DESC
    LIMIT 1
    `,
  );
  if (!result.rows[0]) return null;
  return {
    id: result.rows[0].id,
    updatedAt: result.rows[0].updated_at ?? null,
    configuration: result.rows[0].configuration,
  };
}

// =====================================================================
// SKILL 1: subscribe_connector_mqtt
// =====================================================================
function inspectPayload(rawText) {
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      validJson: false,
      payloadType: "raw_text",
      preview: rawText.slice(0, 200),
      anomalies: ["Payload is not valid JSON"],
    };
  }

  if (!isRecord(parsed)) {
    return {
      validJson: true,
      payloadType: Array.isArray(parsed) ? "json_array" : typeof parsed,
      preview: rawText.slice(0, 200),
      anomalies: [],
    };
  }

  const keys = Object.keys(parsed);
  const matchedTimestamps = CYLINDER_CYCLE_TIMESTAMP_FIELDS.filter((field) => field in parsed);
  if (matchedTimestamps.length > 0) {
    const metrics = computeCylinderCycleMetrics(parsed);
    const missingTimestamps = CYLINDER_CYCLE_TIMESTAMP_FIELDS.filter((field) => !(field in parsed));
    const anomalies = [...metrics.issues];
    if (missingTimestamps.length > 0) {
      anomalies.unshift(`Missing cylinder cycle timestamps: ${missingTimestamps.join(", ")}`);
    }
    return {
      validJson: true,
      payloadType: "modbus_cylinder_datablock",
      cycleCounter: parsed.cycle_counter ?? parsed.udiCycleCounter ?? null,
      partNumber: parsed.part_number ?? parsed.sPartnumber ?? null,
      populatedTimestamps: metrics.populatedTimestamps ?? matchedTimestamps.length,
      totalExpectedTimestamps: CYLINDER_CYCLE_TIMESTAMP_FIELDS.length,
      cycleConsistent: metrics.consistent,
      durationsMs: metrics.durationsMs,
      sample: parsed,
      anomalies,
    };
  }

  if ("cylinderId" in parsed || "valveId" in parsed || "valveTerminalId" in parsed) {
    return {
      validJson: true,
      payloadType: "siemens_mip",
      sample: parsed,
      anomalies: [],
    };
  }

  if ("dataBlock" in parsed && Array.isArray(parsed.values)) {
    return {
      validJson: true,
      payloadType: "opcua_datablock",
      dataBlock: parsed.dataBlock,
      fieldCount: parsed.values.length,
      sample: parsed,
      anomalies: [],
    };
  }

  return {
    validJson: true,
    payloadType: "json_object",
    fieldCount: keys.length,
    sample: Object.fromEntries(keys.slice(0, 12).map((k) => [k, parsed[k]])),
    anomalies: [],
  };
}

function deriveDefaultSubscriptionTopics(cfg) {
  const configured = new Set();
  if (isRecord(cfg)) {
    const normalizedModbusSources = extractModbusSourcesFromConfiguration(cfg);
    for (const entry of normalizedModbusSources) {
      const topics =
        entry.config.readMode === "Read by Datablocks"
          ? (entry.config.blockTopics ?? [])
              .map((t) => (typeof t === "string" ? t : t?.topic))
              .filter(Boolean)
          : [entry.config.mqttTopic || `festo/plc/${entry.id}`];
      for (const topic of topics) {
        if (typeof topic === "string" && topic.trim()) configured.add(topic.trim());
      }
    }

    const rawSources = Array.isArray(cfg.messageSources) ? cfg.messageSources : [];
    for (const source of rawSources) {
      if (!isRecord(source)) continue;
      let parsedUri = null;
      try {
        if (typeof source.uri === "string") parsedUri = new URL(source.uri);
      } catch {
        parsedUri = null;
      }
      const protocol = parsedUri
        ? parsedUri.protocol.replace(":", "")
        : String(source.type ?? "unknown");
      const id = String(source.id ?? source.uniqueKey ?? "unknown").trim();

      let pollerStatus = null;
      if (protocol === "modbus.tcp") {
        pollerStatus = getModbusPollerStatus(id, "modbus");
      } else if (protocol === CUSTOMISED_PROTOCOL) {
        pollerStatus = getCustomisedModbusPollerStatus(id);
      } else if (protocol.includes("siemens") || protocol === "s7") {
        pollerStatus = getSiemensPollerStatus(id);
      } else if (protocol === "opc.tcp") {
        pollerStatus = getOpcuaPollerStatus(id);
      }

      for (const topic of extractTopicsForSource(source, protocol, pollerStatus)) {
        if (topic && typeof topic === "string") configured.add(topic.trim());
      }
    }
  }
  if (configured.size > 0 && configured.size <= 80) {
    return Array.from(configured);
  }
  if (configured.size > 80) {
    const prefixes = new Set();
    for (const topic of configured) {
      const parts = topic.split("/").filter(Boolean);
      if (parts.length >= 2) prefixes.add(`${parts[0]}/${parts[1]}/#`);
      else if (parts.length === 1) prefixes.add(`${parts[0]}/#`);
    }
    if (prefixes.size > 0) return Array.from(prefixes);
  }
  return ["festo/#", "festo-ax/#", "ax/#"];
}

export async function subscribeConnectorMqtt({
  queryFn = defaultQuery,
  args = {},
  mqttConnect = mqtt.connect,
} = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  const savedMqtt = saved?.configuration
    ? extractMqttConfigFromConfiguration(saved.configuration)
    : null;

  const brokerConfig = {
    protocol: args.protocol || savedMqtt?.protocol || "tcp://",
    host: String(args.host || savedMqtt?.host || "").trim(),
    port: Number(args.port || savedMqtt?.port || 1883),
    username: args.username !== undefined ? args.username : (savedMqtt?.username ?? undefined),
    password: args.password !== undefined ? args.password : (savedMqtt?.password ?? undefined),
  };

  if (!brokerConfig.host) {
    return {
      ok: false,
      connected: false,
      error:
        "No MQTT broker host is configured in Connector (connector_configurations) and none was provided in tool arguments.",
      diagnosis: "Configure an MQTT Broker on the Dashboard -> MQTT Connection page first.",
    };
  }

  const durationSeconds = clamp(args.duration_seconds ?? args.durationSeconds, 3, 1, 10);
  const maxMessages = Math.round(clamp(args.max_messages ?? args.maxMessages, 70, 1, 200));

  let topics = [];
  if (Array.isArray(args.topics)) {
    topics = args.topics.map((t) => String(t).trim()).filter(Boolean);
  } else if (typeof args.topic === "string" && args.topic.trim()) {
    topics = [args.topic.trim()];
  }
  if (topics.length === 0) {
    topics = deriveDefaultSubscriptionTopics(saved?.configuration ?? null);
  }

  const brokerUrl = getMqttBrokerUrl(brokerConfig);
  const connectTimeoutMs = 4000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const client = mqttConnect(brokerUrl, {
      clientId: `debug-bot-${Math.random().toString(16).slice(2, 10)}`,
      username: brokerConfig.username || undefined,
      password: brokerConfig.password || undefined,
      connectTimeout: connectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
    });

    let settled = false;
    let connectedAt = null;
    let firstMessageAt = null;
    let samplingTimer = null;
    let connectTimer = null;
    let totalMessages = 0;
    const topicStats = new Map();
    const allAnomalies = new Set();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (samplingTimer) clearTimeout(samplingTimer);
      if (connectTimer) clearTimeout(connectTimer);
      try {
        client.end(true);
      } catch {
        // Ignore cleanup errors.
      }
      resolve(result);
    };

    const buildSuccessResult = () => {
      const elapsedSec = Math.max(0.1, (Date.now() - (connectedAt ?? startedAt)) / 1000);
      const topicsSummary = Array.from(topicStats.entries())
        .slice(0, 40)
        .map(([topic, stat]) => ({
          topic,
          messageCount: stat.count,
          payloadType: stat.lastInspection.payloadType,
          validJson: stat.lastInspection.validJson,
          cycleCounter: stat.lastInspection.cycleCounter ?? undefined,
          partNumber: stat.lastInspection.partNumber ?? undefined,
          populatedTimestamps: stat.lastInspection.populatedTimestamps ?? undefined,
          cycleConsistent: stat.lastInspection.cycleConsistent ?? undefined,
          durationsMs: stat.lastInspection.durationsMs ?? undefined,
          anomalies: stat.lastInspection.anomalies,
          latestSample: stat.lastInspection.sample ?? stat.lastInspection.preview,
          lastReceivedAt: stat.lastReceivedAt,
        }));

      const warnings = Array.from(allAnomalies);
      let diagnosis;
      if (totalMessages === 0) {
        warnings.push(
          `Connected to MQTT broker ${brokerUrl}, but received 0 messages on [${topics.slice(0, 5).join(", ")}${topics.length > 5 ? ", ..." : ""}] within ${durationSeconds}s.`,
        );
        diagnosis =
          "Broker connection succeeded, but no messages arrived during the sampling window. Possible causes: PLC pollers are stopped/offline, cylinder timestamps are unchanged or mid-stroke (gated by cycle-consistency check), or the subscribed topics differ from published topics.";
      } else if (warnings.length > 0) {
        diagnosis = `Received ${totalMessages} messages across ${topicStats.size} topic(s), with ${warnings.length} payload anomaly warning(s).`;
      } else {
        diagnosis = `Healthy: received ${totalMessages} valid message(s) across ${topicStats.size} topic(s) at ${(totalMessages / elapsedSec).toFixed(2)} msg/s.`;
      }

      return {
        ok: true,
        connected: true,
        brokerUrl,
        connectLatencyMs: connectedAt ? connectedAt - startedAt : null,
        firstMessageLatencyMs: connectedAt && firstMessageAt ? firstMessageAt - connectedAt : null,
        subscribedTopics: topics,
        durationSeconds,
        totalMessages,
        uniqueTopicCount: topicStats.size,
        messagesPerSecond: Number((totalMessages / elapsedSec).toFixed(2)),
        topicsSummary,
        warnings,
        diagnosis,
      };
    };

    connectTimer = setTimeout(() => {
      finish({
        ok: false,
        connected: false,
        brokerUrl,
        subscribedTopics: topics,
        error: `MQTT connection timed out after ${connectTimeoutMs}ms`,
        diagnosis: `Unable to reach MQTT broker at ${brokerUrl}. Check broker host/port, network routing, and firewall.`,
      });
    }, connectTimeoutMs);

    client.once("connect", () => {
      if (settled) return;
      clearTimeout(connectTimer);
      connectedAt = Date.now();
      client.subscribe(topics, { qos: 0 }, (err) => {
        if (err) {
          finish({
            ok: false,
            connected: true,
            brokerUrl,
            subscribedTopics: topics,
            error: `MQTT subscribe failed: ${err.message}`,
            diagnosis:
              "Connected to broker, but subscription was rejected (check ACL/credentials or topic syntax).",
          });
          return;
        }
        samplingTimer = setTimeout(() => {
          finish(buildSuccessResult());
        }, durationSeconds * 1000);
      });
    });

    client.on("message", (topic, payloadBuffer) => {
      if (settled) return;
      if (!firstMessageAt) firstMessageAt = Date.now();
      totalMessages += 1;
      const rawText = payloadBuffer.toString("utf8");
      const inspection = inspectPayload(rawText);
      for (const anomaly of inspection.anomalies) {
        allAnomalies.add(`${topic}: ${anomaly}`);
      }
      const existing = topicStats.get(topic);
      if (existing) {
        existing.count += 1;
        existing.lastInspection = inspection;
        existing.lastReceivedAt = new Date().toISOString();
      } else {
        topicStats.set(topic, {
          count: 1,
          lastInspection: inspection,
          lastReceivedAt: new Date().toISOString(),
        });
      }
      if (totalMessages >= maxMessages) {
        finish(buildSuccessResult());
      }
    });

    client.once("error", (error) => {
      finish({
        ok: false,
        connected: Boolean(connectedAt),
        brokerUrl,
        subscribedTopics: topics,
        error: error instanceof Error ? error.message : String(error),
        diagnosis: `MQTT broker error on ${brokerUrl}: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });
}

// =====================================================================
// SKILL 2: inspect_modbus_datablocks (Cylinder data freshness / stale duration monitor)
// =====================================================================
export function inspectModbusDatablocks({
  plcId = null,
  staleThresholdSeconds = 60,
  nowMs = Date.now(),
  getActivePollers = listActiveModbusPollers,
  getStatus = getModbusPollerStatus,
} = {}) {
  const active = getActivePollers();
  const targets = plcId
    ? active.filter((p) => p.id === String(plcId).trim())
    : active;

  if (targets.length === 0) {
    return {
      found: false,
      activePollerIds: active.map((p) => p.id),
      message: plcId
        ? `No active Modbus poller found with id "${plcId}".`
        : "No active Modbus pollers are currently running in backend memory.",
      pollers: [],
    };
  }

  const thresholdSec = clamp(staleThresholdSeconds, 60, 1, 86400);
  const thresholdMs = thresholdSec * 1000;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

  const pollers = targets.map((poller) => {
    const status = getStatus(poller.id, poller.namespace);
    const rawDataBlocks = Array.isArray(status?.dataBlocks) ? status.dataBlocks : [];
    const isCustom = (poller.config.layoutMode ?? "standard") === "custom";
    const lastReadError =
      typeof status?.lastReadError === "string" && status.lastReadError
        ? status.lastReadError
        : status?.pollingStatus === "UNHEALTHY" && !status?.lastPublishError && status?.error
          ? String(status.error)
          : null;
    const readFailed =
      Boolean(lastReadError) ||
      (status?.pollingStatus === "UNHEALTHY" && !status?.lastPublishError);
    const configuredTopics =
      poller.config.readMode === "Read by Datablocks" && Array.isArray(poller.config.blockTopics)
        ? poller.config.blockTopics
        : [];

    const effectiveBlocks =
      rawDataBlocks.length > 0
        ? rawDataBlocks
        : configuredTopics.map((topic, idx) => ({
            index: idx,
            startAddress:
              Number(poller.config.startAddress ?? 0) +
              idx * (isCustom ? 0 : MODBUS_DATABLOCK_REGISTER_COUNT),
            topic,
            values: null,
            synthesizedNoData: true,
          }));

    const cylinders = effectiveBlocks.map((block, idx) => {
      const hasValues = Boolean(block.values && typeof block.values === "object");
      const firstSeenAt =
        typeof block.firstSeenAt === "number"
          ? block.firstSeenAt
          : hasValues && typeof status?.updatedAt === "number"
            ? status.updatedAt
            : null;
      const lastRawChangedAt =
        typeof block.lastRawChangedAt === "number"
          ? block.lastRawChangedAt
          : typeof block.lastDataUpdatedAt === "number"
            ? block.lastDataUpdatedAt
            : null;
      const hasLiveGateTelemetry =
        typeof block.validCycleCount === "number" ||
        block.lastValidCycleAt !== undefined ||
        block.lastRejectedChangeAt !== undefined;
      const lastValidCycleAt = hasLiveGateTelemetry
        ? typeof block.lastValidCycleAt === "number"
          ? block.lastValidCycleAt
          : null
        : lastRawChangedAt;
      const lastRejectedChangeAt =
        typeof block.lastRejectedChangeAt === "number" ? block.lastRejectedChangeAt : null;
      const rawChangeCount =
        typeof block.rawChangeCount === "number"
          ? block.rawChangeCount
          : typeof block.updateCount === "number"
            ? block.updateCount
            : lastRawChangedAt !== null
              ? 1
              : 0;
      const validCycleCount = hasLiveGateTelemetry
        ? typeof block.validCycleCount === "number"
          ? block.validCycleCount
          : 0
        : rawChangeCount;
      const publishCount =
        typeof block.publishCount === "number" ? block.publishCount : validCycleCount;
      const changedFields = Array.isArray(block.changedFieldsSinceValid)
        ? block.changedFieldsSinceValid
        : [];

      const publishGate =
        block.publishGate && typeof block.publishGate === "object"
          ? block.publishGate
          : hasValues
            ? (() => {
                const evaluated = evaluateDatablockPublishGate(block.values, null, { isCustom });
                return {
                  enforced: evaluated.enforced,
                  eligible: evaluated.eligible,
                  consistent: evaluated.consistent,
                  progressed: evaluated.progressed,
                  reason: evaluated.reason,
                  detail: evaluated.detail,
                  zeroFields: evaluated.zeroFields,
                  changedTimestampFields: evaluated.changedTimestampFields,
                  unchangedTimestampFields: evaluated.unchangedTimestampFields,
                };
              })()
            : null;

      const hasUpdatedSinceStart = lastValidCycleAt !== null;
      const referenceTime = lastValidCycleAt ?? firstSeenAt;
      const staleDurationMs =
        referenceTime !== null ? Math.max(0, Math.round(now - referenceTime)) : null;
      const staleDurationSeconds =
        staleDurationMs !== null ? Number((staleDurationMs / 1000).toFixed(1)) : null;
      const timeExceeded = staleDurationMs !== null && staleDurationMs >= thresholdMs;

      const hasRejectedRawChange = hasLiveGateTelemetry
        ? Boolean(
            lastRejectedChangeAt !== null &&
              (lastValidCycleAt === null || lastRejectedChangeAt >= lastValidCycleAt),
          )
        : Boolean(
            lastRawChangedAt !== null &&
              publishGate?.enforced &&
              publishGate.consistent === false,
          );

      let freshnessStatus;
      let nonFreshReason;
      let reasonDetail;
      let isStale = timeExceeded;

      if (readFailed || !hasValues) {
        freshnessStatus = readFailed ? "READ_FAILED" : "NO_DATA";
        nonFreshReason = "READ_FAILED";
        isStale = true;
        reasonDetail =
          lastReadError ||
          status?.error ||
          "No datablock data has been read from the Modbus PLC yet.";
      } else if (hasRejectedRawChange) {
        freshnessStatus = "REJECTED_CHANGE";
        nonFreshReason = "PARTIAL_CHANGE_REJECTED";
        isStale = true;
        const fieldsPrefix =
          changedFields.length > 0
            ? `Changed fields: [${changedFields.map((f) => f.replace(/^timestamp_/, "")).join(", ")}] — `
            : "";
        reasonDetail = `${fieldsPrefix}${publishGate?.detail || "Data changed but does not satisfy the 6-timestamp publish standard."}`;
      } else if (lastValidCycleAt !== null && staleDurationMs !== null && !timeExceeded) {
        freshnessStatus = "FRESH";
        nonFreshReason = null;
        reasonDetail = null;
      } else {
        freshnessStatus = timeExceeded ? "STALE" : "NEVER_UPDATED";
        nonFreshReason = "DATA_UNCHANGED";
        reasonDetail =
          publishGate?.enforced && publishGate.consistent === false
            ? `PLC read OK, register values unchanged (current static snapshot also fails publish gate: ${publishGate.detail}).`
            : "PLC read OK, register values have not changed.";
      }

      return {
        blockIndex: block.index ?? idx,
        startAddress: block.startAddress,
        topic: block.topic,
        partNumber: block.values?.part_number ?? block.values?.sPartnumber ?? null,
        cycleCounter: block.values?.cycle_counter ?? block.values?.udiCycleCounter ?? null,
        firstSeenAt: firstSeenAt !== null ? new Date(firstSeenAt).toISOString() : null,
        lastDataUpdatedAt:
          lastValidCycleAt !== null ? new Date(lastValidCycleAt).toISOString() : null,
        lastValidCycleAt:
          lastValidCycleAt !== null ? new Date(lastValidCycleAt).toISOString() : null,
        lastRawChangedAt:
          lastRawChangedAt !== null ? new Date(lastRawChangedAt).toISOString() : null,
        lastRejectedChangeAt:
          lastRejectedChangeAt !== null ? new Date(lastRejectedChangeAt).toISOString() : null,
        hasUpdatedSinceStart,
        updateCount: validCycleCount,
        validCycleCount,
        rawChangeCount,
        publishCount,
        staleDurationMs,
        staleDurationSeconds,
        isStale,
        freshnessStatus,
        nonFreshReason,
        reasonDetail,
        changedFields,
        publishGate,
      };
    });

    // Sort longest un-updated first (READ_FAILED with null duration prioritized at top); tie-break by block index.
    cylinders.sort((a, b) => {
      const aVal = a.staleDurationMs ?? (a.nonFreshReason === "READ_FAILED" ? Number.MAX_SAFE_INTEGER : -1);
      const bVal = b.staleDurationMs ?? (b.nonFreshReason === "READ_FAILED" ? Number.MAX_SAFE_INTEGER : -1);
      const diff = bVal - aVal;
      return diff !== 0 ? diff : a.blockIndex - b.blockIndex;
    });

    const staleValues = cylinders
      .map((c) => c.staleDurationMs)
      .filter((v) => typeof v === "number");
    const maxStaleDurationMs = staleValues.length > 0 ? Math.max(...staleValues) : null;

    return {
      plcId: poller.id,
      namespace: poller.namespace,
      endpoint: `${poller.config.host}:${poller.config.port}`,
      unitId: poller.config.unitId,
      readMode: poller.config.readMode,
      layoutMode: poller.config.layoutMode ?? "standard",
      endian: poller.config.endian ?? "Big-Endian",
      pollingMs: poller.config.polling,
      pollingStatus: status?.pollingStatus ?? "UNKNOWN",
      lastError: status?.error ?? null,
      lastReadError,
      lastPublishError: status?.lastPublishError ?? null,
      consecutiveReadErrors: status?.consecutiveReadErrors ?? 0,
      lastReadAt: status?.lastReadAt ? new Date(status.lastReadAt).toISOString() : null,
      lastPollAt: status?.updatedAt ? new Date(status.updatedAt).toISOString() : null,
      checkedAt: new Date(now).toISOString(),
      summary: {
        totalCylinders: cylinders.length,
        staleThresholdSeconds: thresholdSec,
        freshCount: cylinders.filter((c) => c.freshnessStatus === "FRESH").length,
        staleCount: cylinders.filter((c) => c.isStale).length,
        neverUpdatedCount: cylinders.filter((c) => !c.hasUpdatedSinceStart).length,
        readFailedCount: cylinders.filter((c) => c.nonFreshReason === "READ_FAILED").length,
        unchangedCount: cylinders.filter((c) => c.nonFreshReason === "DATA_UNCHANGED").length,
        rejectedChangeCount: cylinders.filter(
          (c) => c.nonFreshReason === "PARTIAL_CHANGE_REJECTED",
        ).length,
        maxStaleDurationMs,
        maxStaleDurationSeconds:
          maxStaleDurationMs !== null ? Number((maxStaleDurationMs / 1000).toFixed(1)) : null,
      },
      cylinders,
    };
  });

  return {
    found: true,
    pollerCount: pollers.length,
    pollers,
  };
}

// =====================================================================
// SKILL 3: validate_connector_configuration (Static & semantic config audit)
// =====================================================================
export async function validateConnectorConfiguration({ queryFn = defaultQuery } = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  if (!saved?.configuration) {
    return {
      valid: false,
      issueCount: 1,
      errors: ["No saved Connector configuration found in PostgreSQL."],
      warnings: [],
      checks: [],
    };
  }

  const cfg = saved.configuration;
  const errors = [];
  const warnings = [];
  const checks = [];

  // 1. MQTT broker audit
  const mqttConfig = extractMqttConfigFromConfiguration(cfg);
  if (!mqttConfig) {
    warnings.push("MQTT broker host is empty — PLC data will be read but not published to MQTT.");
  } else {
    checks.push({
      target: "MQTT Broker",
      status: "ok",
      detail: `${mqttConfig.protocol}${mqttConfig.host}:${mqttConfig.port} (QoS ${mqttConfig.qos}, ${mqttConfig.authType})`,
    });
  }

  const sources = Array.isArray(cfg.messageSources) ? cfg.messageSources : [];
  if (sources.length === 0) {
    warnings.push("No PLC messageSources are configured.");
  }

  const seenIds = new Set();
  const topicOwners = new Map();
  const modbusRanges = [];

  for (const source of sources) {
    if (!isRecord(source)) continue;
    const id = String(source.id ?? "").trim();
    let uri;
    try {
      uri = new URL(String(source.uri ?? ""));
    } catch {
      errors.push(`Source "${id || "(unnamed)"}" has an invalid URI: ${String(source.uri ?? "")}`);
      continue;
    }

    const protocol = uri.protocol.replace(":", "");
    const idKey = `${protocol}:${id}`;
    if (!id) {
      errors.push(`A ${protocol} source is missing its PLC Id.`);
    } else if (seenIds.has(idKey)) {
      errors.push(`Duplicate PLC Id "${id}" under protocol ${protocol}.`);
    } else {
      seenIds.add(idKey);
    }

    const raw = isRecord(source.configuration)
      ? source.configuration
      : isRecord(source[`${protocol}Configuration`])
        ? source[`${protocol}Configuration`]
        : {};

    if (protocol === "modbus.tcp" || protocol === CUSTOMISED_PROTOCOL) {
      const host = uri.hostname || String(raw.host ?? "");
      const port = Number(uri.port || raw.port || 502);
      const unitId = Number(raw.unitId ?? 1);
      const pollingMs = Number(raw.polling ?? 500);
      const byDatablocks =
        protocol === CUSTOMISED_PROTOCOL || raw.readMode === "Read by Datablocks";

      if (byDatablocks) {
        const isCustom = protocol === CUSTOMISED_PROTOCOL || raw.layoutMode === "custom";
        let registersPerBlock = MODBUS_DATABLOCK_REGISTER_COUNT;
        if (isCustom) {
          try {
            registersPerBlock = buildCustomisedLayout(raw.fields).registerCount;
          } catch (error) {
            errors.push(`PLC "${id}" custom datablock layout is invalid: ${error.message}`);
            continue;
          }
        }
        const startAddress = Number(raw.startAddress ?? 0);
        const blockCount = Number(raw.registerCount ?? raw.blockCount ?? 0);
        const totalRegisters = blockCount * registersPerBlock;
        const endAddress = startAddress + totalRegisters - 1;

        if (!Number.isInteger(blockCount) || blockCount < 1) {
          errors.push(`PLC "${id}" has invalid datablock count: ${raw.registerCount ?? raw.blockCount}`);
        } else if (endAddress > 65535) {
          errors.push(
            `PLC "${id}" register range ${startAddress}..${endAddress} exceeds Modbus maximum address 65535.`,
          );
        }

        const blocksPerBatch = Math.max(
          1,
          Math.floor(MODBUS_MAX_READ_REGISTERS / Math.max(1, registersPerBlock)),
        );
        const fc03RequestsPerPoll = Math.ceil(Math.max(1, blockCount) / blocksPerBatch);

        // Estimate realistic LAN polling cycle time (~10ms/request conservative baseline)
        const estimatedMinMs = fc03RequestsPerPoll * 10;
        if (pollingMs < estimatedMinMs) {
          warnings.push(
            `PLC "${id}" requires ${fc03RequestsPerPoll} FC03 requests per poll (${blockCount} DBs × ${registersPerBlock} regs). Polling interval ${pollingMs}ms may be tighter than PLC response time (~${estimatedMinMs}ms at 10ms/req). Consider splitting across multiple PLC ports or tuning polling interval.`,
          );
        }

        const topics = Array.isArray(raw.blockTopics) ? raw.blockTopics : [];
        if (topics.length !== blockCount) {
          errors.push(
            `PLC "${id}" has ${topics.length} MQTT topics configured for ${blockCount} datablocks (counts must match).`,
          );
        }
        topics.forEach((rawTopic, idx) => {
          const topic = typeof rawTopic === "string" ? rawTopic.trim() : "";
          if (!topic || !isValidMqttPublishTopic(topic)) {
            errors.push(`PLC "${id}" DB #${idx + 1} has an invalid MQTT topic "${topic}".`);
          } else if (topicOwners.has(topic)) {
            warnings.push(
              `Duplicate MQTT topic "${topic}" shared by ${topicOwners.get(topic)} and PLC "${id}" DB #${idx + 1}.`,
            );
          } else {
            topicOwners.set(topic, `PLC "${id}" DB #${idx + 1}`);
          }
        });

        // Check overlapping address ranges on the same endpoint + unitId
        const rangeKey = `${host.toLowerCase()}:${port}:u${unitId}`;
        for (const prev of modbusRanges) {
          if (
            prev.rangeKey === rangeKey &&
            startAddress <= prev.endAddress &&
            endAddress >= prev.startAddress
          ) {
            warnings.push(
              `PLC "${id}" registers (${startAddress}..${endAddress}) overlap with PLC "${prev.id}" (${prev.startAddress}..${prev.endAddress}) on ${rangeKey}.`,
            );
          }
        }
        modbusRanges.push({ id, rangeKey, startAddress, endAddress });

        checks.push({
          target: `Modbus "${id}"`,
          status: "ok",
          detail: `${host}:${port} (Unit ${unitId}) · ${blockCount} DBs × ${registersPerBlock} regs (${startAddress}..${endAddress}) · ${fc03RequestsPerPoll} FC03 reqs/poll @ ${pollingMs}ms`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    configurationId: saved.id,
    configurationUpdatedAt: saved.updatedAt,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    checks,
  };
}

// =====================================================================
// SKILL 6: test_plc_and_mqtt_connectivity (Active protocol handshake probe)
// =====================================================================
export async function testPlcAndMqttConnectivity({
  queryFn = defaultQuery,
  args = {},
  probeTcp = probeTcpReachability,
  testModbus = testModbusPollerConnection,
  testMqtt = testMqttConnection,
  testOpcua = testOpcuaConnection,
} = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  if (!saved?.configuration) {
    return {
      ok: false,
      error: "No saved Connector configuration found in PostgreSQL.",
    };
  }

  const cfg = saved.configuration;
  const targetId = typeof args.plc_id === "string" && args.plc_id.trim() ? args.plc_id.trim() : null;
  const includeMqtt = args.include_mqtt !== false;

  let mqttResult = null;
  if (includeMqtt) {
    const mqttConfig = extractMqttConfigFromConfiguration(cfg);
    if (!mqttConfig) {
      mqttResult = { configured: false, ok: false, error: "MQTT broker not configured" };
    } else {
      const tcp = await probeTcp(mqttConfig.host, mqttConfig.port);
      const startedAt = Date.now();
      try {
        await testMqtt(mqttConfig);
        mqttResult = {
          configured: true,
          ok: true,
          endpoint: `${mqttConfig.host}:${mqttConfig.port}`,
          tcpLatencyMs: tcp.latencyMs,
          handshakeLatencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        mqttResult = {
          configured: true,
          ok: false,
          endpoint: `${mqttConfig.host}:${mqttConfig.port}`,
          tcpReachable: tcp.reachable,
          tcpError: tcp.error,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const plcResults = [];
  const modbusEntries = extractModbusSourcesFromConfiguration(cfg).filter(
    (entry) => !targetId || entry.id === targetId,
  );

  for (const entry of modbusEntries) {
    const tcp = await probeTcp(entry.config.host, entry.config.port);
    const startedAt = Date.now();
    try {
      const sample = await testModbus(entry.config);
      plcResults.push({
        id: entry.id,
        protocol: entry.namespace === "customised" ? CUSTOMISED_PROTOCOL : "modbus.tcp",
        endpoint: `${entry.config.host}:${entry.config.port}`,
        unitId: entry.config.unitId,
        ok: true,
        tcpLatencyMs: tcp.latencyMs,
        protocolReadLatencyMs: Date.now() - startedAt,
        blocksRead: Array.isArray(sample) ? sample.length : 1,
      });
    } catch (error) {
      plcResults.push({
        id: entry.id,
        protocol: entry.namespace === "customised" ? CUSTOMISED_PROTOCOL : "modbus.tcp",
        endpoint: `${entry.config.host}:${entry.config.port}`,
        unitId: entry.config.unitId,
        ok: false,
        tcpReachable: tcp.reachable,
        tcpError: tcp.error,
        protocolReadLatencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rawSources = Array.isArray(cfg.messageSources) ? cfg.messageSources : [];
  for (const source of rawSources) {
    if (!isRecord(source) || typeof source.uri !== "string") continue;
    let uri;
    try {
      uri = new URL(source.uri);
    } catch {
      continue;
    }
    const protocol = uri.protocol.replace(":", "");
    const id = String(source.id ?? "").trim();
    if (protocol !== "opc.tcp" || (targetId && id !== targetId)) continue;
    const raw = isRecord(source.configuration) ? source.configuration : {};
    const host = uri.hostname;
    const port = Number(uri.port || 4840);
    const tcp = await probeTcp(host, port);
    const startedAt = Date.now();
    try {
      await testOpcua({ ...raw, id, host, port });
      plcResults.push({
        id,
        protocol: "opc.tcp",
        endpoint: `${host}:${port}`,
        ok: true,
        tcpLatencyMs: tcp.latencyMs,
        handshakeLatencyMs: Date.now() - startedAt,
      });
    } catch (error) {
      plcResults.push({
        id,
        protocol: "opc.tcp",
        endpoint: `${host}:${port}`,
        ok: false,
        tcpReachable: tcp.reachable,
        tcpError: tcp.error,
        handshakeLatencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const allOk =
    (!mqttResult || mqttResult.ok) &&
    plcResults.every((r) => r.ok);

  return {
    ok: allOk,
    mqtt: mqttResult,
    plcs: plcResults,
  };
}

// =====================================================================
// SKILL 7: get_system_runtime_health (DB, memory, uptime, recent error log)
// =====================================================================
export async function getSystemRuntimeHealth({
  queryFn = defaultQuery,
  eventLimit = 25,
} = {}) {
  const dbStartedAt = Date.now();
  let database;
  try {
    const res = await queryFn(
      "SELECT COUNT(*)::int AS count, MAX(updated_at) AS latest_updated_at FROM public.connector_configurations",
    );
    database = {
      ok: true,
      latencyMs: Date.now() - dbStartedAt,
      savedConfigurations: Number(res.rows[0]?.count ?? 0),
      latestConfigurationUpdatedAt: res.rows[0]?.latest_updated_at ?? null,
      error: null,
    };
  } catch (error) {
    database = {
      ok: false,
      latencyMs: Date.now() - dbStartedAt,
      savedConfigurations: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const mem = process.memoryUsage();
  const activeModbus = listActiveModbusPollers();
  const activeOpcua = listActiveOpcuaPollers();

  return {
    nodeVersion: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    database,
    activePollers: {
      modbusCount: activeModbus.length,
      modbusIds: activeModbus.map((p) => `${p.namespace}:${p.id}`),
      opcuaCount: activeOpcua.length,
      opcuaIds: activeOpcua.map((p) => p.id),
    },
    recentEvents: getRecentDiagnosticEvents({ limit: eventLimit }),
  };
}

// =====================================================================
// SKILL 8: diagnose_opcua_and_siemens (Siemens S7 & OPC UA live inspection)
// =====================================================================
export async function diagnoseOpcuaAndSiemens({
  queryFn = defaultQuery,
  args = {},
  browseOpcua = browseOpcuaNodes,
} = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  const rawSources = Array.isArray(saved?.configuration?.messageSources)
    ? saved.configuration.messageSources
    : [];

  const siemens = [];
  const opcua = [];
  const browseTargetId =
    typeof args.browse_opcua_plc_id === "string" ? args.browse_opcua_plc_id.trim() : "";
  const browseNodeId =
    typeof args.browse_node_id === "string" && args.browse_node_id.trim()
      ? args.browse_node_id.trim()
      : undefined;

  for (const source of rawSources) {
    if (!isRecord(source) || typeof source.uri !== "string") continue;
    let uri;
    try {
      uri = new URL(source.uri);
    } catch {
      continue;
    }
    const protocol = uri.protocol.replace(":", "");
    const id = String(source.id ?? "").trim();

    if (protocol === "s7" || protocol.includes("siemens")) {
      const status = getSiemensPollerStatus(id);
      siemens.push({
        id,
        host: uri.hostname,
        port: Number(uri.port || 102),
        rack: uri.searchParams.get("remote-rack") ?? "0",
        slot: uri.searchParams.get("remote-slot") ?? "1",
        configuration: source.s7PniConfiguration ?? source.configuration ?? {},
        liveStatus: status,
      });
    } else if (protocol === "opc.tcp") {
      const raw = isRecord(source.configuration) ? source.configuration : {};
      const status = getOpcuaPollerStatus(id);
      let browsedNodes = null;
      let browseError = null;
      if (browseTargetId && browseTargetId === id) {
        try {
          browsedNodes = await browseOpcua(
            { ...raw, id, host: uri.hostname, port: Number(uri.port || 4840) },
            browseNodeId,
          );
        } catch (error) {
          browseError = error instanceof Error ? error.message : String(error);
        }
      }
      opcua.push({
        id,
        host: uri.hostname,
        port: Number(uri.port || 4840),
        server: raw.server ?? "",
        securityMode: raw.securityMode ?? "NONE_MODE",
        securityPolicy: raw.securityPolicy ?? "NONE",
        liveStatus: status,
        ...(browsedNodes ? { browsedNodes: browsedNodes.slice(0, 50) } : {}),
        ...(browseError ? { browseError } : {}),
      });
    }
  }

  return {
    siemensCount: siemens.length,
    opcuaCount: opcua.length,
    siemens,
    opcua,
  };
}

// =====================================================================
// SKILL 7: diagnose_mqtt_broker_backlog (Broker $SYS queue, backpressure & loopback)
// =====================================================================
function parseSysNumeric(rawText) {
  const match = String(rawText ?? "").trim().match(/^-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

function summarizeSysMetrics(sysMap) {
  const summary = {
    brokerVersion: null,
    uptime: null,
    storedMessages: null,
    retainedMessages: null,
    queuedMessages: null,
    estimatedQueuedMessages: null,
    storedBytes: null,
    droppedMessages: null,
    droppedNoSubscribers: null,
    droppedRate1m: null,
    connectedClients: null,
    disconnectedClients: null,
    totalClients: null,
    sessionsCount: null,
    subscriptionsCount: null,
    receivedRate1m: null,
    sentRate1m: null,
    publishReceivedRate1m: null,
    publishSentRate1m: null,
    totalReceived: null,
    totalSent: null,
  };

  const addValue = (key, value) => {
    if (value === null) return;
    summary[key] = summary[key] === null ? value : summary[key] + value;
  };

  const rawSample = {};
  for (const [topic, raw] of sysMap.entries()) {
    const lower = topic.toLowerCase();
    const num = parseSysNumeric(raw);

    if (
      lower === "$sys/broker/version" ||
      /^\$sys\/brokers\/[^/]+\/(?:version|sysdescr)$/.test(lower)
    ) {
      if (!summary.brokerVersion) summary.brokerVersion = raw;
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/uptime" ||
      /^\$sys\/brokers\/[^/]+\/uptime$/.test(lower)
    ) {
      if (!summary.uptime) summary.uptime = raw;
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/store/messages/count" ||
      lower === "$sys/broker/messages/stored"
    ) {
      if (num !== null) summary.storedMessages = num;
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/store/messages/bytes") {
      if (num !== null) summary.storedBytes = num;
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/retained messages/count" ||
      /^\$sys\/brokers\/[^/]+\/(?:stats\/retained\/count|metrics\/messages\/retained)$/.test(lower)
    ) {
      addValue("retainedMessages", num);
      rawSample[topic] = raw;
    } else if (
      /^\$sys\/brokers\/[^/]+\/metrics\/messages\/(?:queued|delayed)$/.test(lower) ||
      /\/(?:mqueue|queued|inflight)(?:\/count)?$/.test(lower)
    ) {
      addValue("queuedMessages", num);
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/publish/messages/dropped" ||
      /^\$sys\/brokers\/[^/]+\/metrics\/messages\/dropped(?:\/(?:expired|queue_purge|await_pubrel_timeout))?$/.test(
        lower,
      )
    ) {
      addValue("droppedMessages", num);
      rawSample[topic] = raw;
    } else if (/^\$sys\/brokers\/[^/]+\/metrics\/messages\/dropped\/no_subscribers$/.test(lower)) {
      addValue("droppedNoSubscribers", num);
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/load/publish/dropped/1min") {
      if (num !== null) summary.droppedRate1m = num;
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/clients/connected" ||
      /^\$sys\/brokers\/[^/]+\/stats\/clients\/count$/.test(lower)
    ) {
      addValue("connectedClients", num);
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/clients/disconnected") {
      if (num !== null) summary.disconnectedClients = num;
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/clients/total") {
      if (num !== null) summary.totalClients = num;
      rawSample[topic] = raw;
    } else if (/^\$sys\/brokers\/[^/]+\/stats\/sessions\/count$/.test(lower)) {
      addValue("sessionsCount", num);
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/subscriptions/count" ||
      /^\$sys\/brokers\/[^/]+\/stats\/subscriptions\/count$/.test(lower)
    ) {
      addValue("subscriptionsCount", num);
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/load/messages/received/1min") {
      if (num !== null) summary.receivedRate1m = num;
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/load/messages/sent/1min") {
      if (num !== null) summary.sentRate1m = num;
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/load/publish/received/1min") {
      if (num !== null) summary.publishReceivedRate1m = num;
      rawSample[topic] = raw;
    } else if (lower === "$sys/broker/load/publish/sent/1min") {
      if (num !== null) summary.publishSentRate1m = num;
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/messages/received" ||
      /^\$sys\/brokers\/[^/]+\/metrics\/messages\/received$/.test(lower)
    ) {
      addValue("totalReceived", num);
      rawSample[topic] = raw;
    } else if (
      lower === "$sys/broker/messages/sent" ||
      /^\$sys\/brokers\/[^/]+\/metrics\/messages\/sent$/.test(lower)
    ) {
      addValue("totalSent", num);
      rawSample[topic] = raw;
    }
  }

  // Mosquitto's store/messages/count includes retained messages; subtract retained to estimate actual queued backlog.
  if (summary.queuedMessages !== null) {
    summary.estimatedQueuedMessages = Math.max(0, Math.round(summary.queuedMessages));
  } else if (summary.storedMessages !== null) {
    summary.estimatedQueuedMessages = Math.max(
      0,
      Math.round(summary.storedMessages - (summary.retainedMessages ?? 0)),
    );
  }

  // EMQX exposes total sessions vs connected clients; excess sessions are offline persistent sessions.
  if (
    summary.disconnectedClients === null &&
    summary.sessionsCount !== null &&
    summary.connectedClients !== null
  ) {
    summary.disconnectedClients = Math.max(0, Math.round(summary.sessionsCount - summary.connectedClients));
  }

  // Include extra $SYS entries up to 40 total if rawSample is still short.
  if (Object.keys(rawSample).length < 40) {
    for (const [topic, raw] of sysMap.entries()) {
      if (Object.keys(rawSample).length >= 40) break;
      if (!(topic in rawSample)) rawSample[topic] = raw;
    }
  }

  return {
    available: sysMap.size > 0,
    topicCount: sysMap.size,
    ...summary,
    rawSample,
  };
}

export async function diagnoseMqttBrokerBacklog({
  queryFn = defaultQuery,
  args = {},
  mqttConnect = mqtt.connect,
  getPublisherStats = getMqttPublisherStats,
} = {}) {
  const saved = await loadSavedConnectorConfiguration(queryFn);
  const savedMqtt = saved?.configuration
    ? extractMqttConfigFromConfiguration(saved.configuration)
    : null;

  const brokerConfig = {
    protocol: args.protocol || savedMqtt?.protocol || "tcp://",
    host: String(args.host || savedMqtt?.host || "").trim(),
    port: Number(args.port || savedMqtt?.port || 1883),
    username: args.username !== undefined ? args.username : (savedMqtt?.username ?? undefined),
    password: args.password !== undefined ? args.password : (savedMqtt?.password ?? undefined),
  };

  const publisherBackpressure = getPublisherStats();

  if (!brokerConfig.host) {
    return {
      ok: false,
      connected: false,
      status: "UNREACHABLE",
      error: "No MQTT broker host is configured in Connector and none was provided in tool arguments.",
      publisherBackpressure,
      diagnosis: "Configure an MQTT Broker on the Dashboard -> MQTT Connection page first.",
      findings: ["MQTT broker host is not configured."],
      recommendations: ["Configure the MQTT broker address and credentials in Dashboard -> MQTT Connection."],
    };
  }

  const durationSeconds = clamp(args.duration_seconds ?? args.durationSeconds, 2, 1, 8);
  const includeLoopbackProbe = args.include_loopback_probe !== false;
  const brokerUrl = getMqttBrokerUrl(brokerConfig);
  const connectTimeoutMs = 4000;
  const startedAt = Date.now();
  const probeId = Math.random().toString(16).slice(2, 10);
  const probeTopic = `festo/connector/debug-probe/${probeId}`;

  return new Promise((resolve) => {
    const client = mqttConnect(brokerUrl, {
      clientId: `debug-bot-backlog-${probeId}`,
      username: brokerConfig.username || undefined,
      password: brokerConfig.password || undefined,
      connectTimeout: connectTimeoutMs,
      reconnectPeriod: 0,
      clean: true,
    });

    let settled = false;
    let connectedAt = null;
    let connectTimer = null;
    let samplingTimer = null;
    let sysSubscribeDenied = false;
    const sysMap = new Map();

    const loopbackProbe = {
      enabled: includeLoopbackProbe,
      ok: false,
      topic: includeLoopbackProbe ? probeTopic : null,
      pubackLatencyMs: null,
      roundTripLatencyMs: null,
      error: null,
    };
    let probeSentAt = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (samplingTimer) clearTimeout(samplingTimer);
      try {
        client.end(true);
      } catch {
        // Ignore cleanup errors.
      }
      resolve(result);
    };

    const buildDiagnosis = () => {
      const sysMetrics = summarizeSysMetrics(sysMap);
      const findings = [];
      const recommendations = [];
      let backlogDetected = false;
      let hasWarning = false;

      // 1. Evaluate Broker $SYS queue / dropped / rate / offline session indicators
      if (!sysMetrics.available) {
        hasWarning = true;
        findings.push(
          sysSubscribeDenied
            ? "Broker rejected subscription to $SYS/# (ACL restricted); unable to read internal broker queue counters directly."
            : `No $SYS/# telemetry received from broker within ${durationSeconds}s ($SYS may be disabled, interval > ${durationSeconds}s, or restricted by ACL).`,
        );
        recommendations.push(
          "If using Mosquitto/EMQX, allow read access to $SYS/# for the Connector diagnostic account (or inspect Broker dashboard / management API) to view per-client queue depth.",
        );
      } else {
        if (sysMetrics.estimatedQueuedMessages !== null && sysMetrics.estimatedQueuedMessages >= 100) {
          backlogDetected = true;
          findings.push(
            `Broker has ~${sysMetrics.estimatedQueuedMessages} non-retained messages queued in store (stored=${sysMetrics.storedMessages}, retained=${sysMetrics.retainedMessages ?? 0}).`,
          );
          recommendations.push(
            "Check downstream MQTT consumers: a slow or offline persistent subscriber (cleanSession=false) is causing messages to pile up on the broker.",
          );
        } else if (sysMetrics.estimatedQueuedMessages !== null && sysMetrics.estimatedQueuedMessages > 0) {
          hasWarning = true;
          findings.push(
            `Broker currently holds ~${sysMetrics.estimatedQueuedMessages} queued non-retained message(s) (stored=${sysMetrics.storedMessages}, retained=${sysMetrics.retainedMessages ?? 0}).`,
          );
        }

        if (sysMetrics.droppedMessages !== null && sysMetrics.droppedMessages > 0) {
          backlogDetected = true;
          findings.push(
            `Broker reports ${sysMetrics.droppedMessages} dropped publish message(s)${sysMetrics.droppedRate1m ? ` (${sysMetrics.droppedRate1m}/min)` : ""} — queue capacity or inflight window exceeded.`,
          );
          recommendations.push(
            "Increase consumer throughput or raise broker max_queued_messages / max_inflight_messages after clearing stuck sessions.",
          );
        }

        if (sysMetrics.disconnectedClients !== null && sysMetrics.disconnectedClients > 0) {
          hasWarning = true;
          findings.push(
            `Broker has ${sysMetrics.disconnectedClients} disconnected persistent session(s) (connected=${sysMetrics.connectedClients ?? "?"}), which accumulate queued QoS 1/2 messages while offline.`,
          );
          recommendations.push(
            "Verify whether disconnected downstream clients with cleanSession=false are intentionally offline or stuck/abandoned.",
          );
        }

        const inRate = sysMetrics.publishReceivedRate1m ?? sysMetrics.receivedRate1m;
        const outRate = sysMetrics.publishSentRate1m ?? sysMetrics.sentRate1m;
        if (inRate !== null && outRate !== null && inRate >= 10 && outRate < inRate * 0.5) {
          hasWarning = true;
          findings.push(
            `Broker ingress rate (${inRate}/min) is significantly higher than egress rate (${outRate}/min) — either consumers are lagging behind or topics have no active subscribers.`,
          );
          recommendations.push(
            "Confirm downstream subscribers are subscribed to the exact topics Connector publishes and can process the incoming message rate.",
          );
        }
      }

      // 2. Evaluate Connector Publisher backpressure (PUBACK wait, timeouts, socket buffer)
      if (publisherBackpressure.inFlightCount >= 10) {
        backlogDetected = true;
        findings.push(
          `Connector currently has ${publisherBackpressure.inFlightCount} unacknowledged in-flight QoS publish(es) waiting for Broker PUBACK (peak=${publisherBackpressure.maxInFlightCount}).`,
        );
        recommendations.push(
          "Broker PUBACK processing is congested or network link is saturated; check Broker CPU, disk persistence I/O, and network latency.",
        );
      }
      if (publisherBackpressure.totalTimeouts > 0) {
        backlogDetected = true;
        findings.push(
          `Connector experienced ${publisherBackpressure.totalTimeouts} MQTT publish timeout(s) (last error: ${publisherBackpressure.lastErrorMessage || "timeout"}).`,
        );
      }
      if (publisherBackpressure.totalOutgoingBufferBytes > 65536) {
        backlogDetected = true;
        findings.push(
          `Connector TCP outgoing buffer toward Broker is backed up (${publisherBackpressure.totalOutgoingBufferBytes} bytes queued in Node socket).`,
        );
      }
      if (publisherBackpressure.avgPublishLatencyMs !== null && publisherBackpressure.avgPublishLatencyMs >= 500) {
        backlogDetected = true;
        findings.push(
          `High Connector publish-to-PUBACK latency: avg ${publisherBackpressure.avgPublishLatencyMs}ms (p95=${publisherBackpressure.p95PublishLatencyMs}ms, max=${publisherBackpressure.maxPublishLatencyMs}ms).`,
        );
      } else if (
        publisherBackpressure.avgPublishLatencyMs !== null &&
        publisherBackpressure.avgPublishLatencyMs >= 150
      ) {
        hasWarning = true;
        findings.push(
          `Elevated Connector publish-to-PUBACK latency: avg ${publisherBackpressure.avgPublishLatencyMs}ms (max=${publisherBackpressure.maxPublishLatencyMs}ms).`,
        );
      }

      // 3. Evaluate Loopback Probe latency
      if (includeLoopbackProbe) {
        if (!loopbackProbe.ok) {
          hasWarning = true;
          findings.push(
            `QoS 1 loopback latency probe did not complete${loopbackProbe.error ? ` (${loopbackProbe.error})` : " (timed out or blocked by Broker ACL)"}.`,
          );
        } else if (
          (loopbackProbe.pubackLatencyMs !== null && loopbackProbe.pubackLatencyMs >= 500) ||
          (loopbackProbe.roundTripLatencyMs !== null && loopbackProbe.roundTripLatencyMs >= 1000)
        ) {
          backlogDetected = true;
          findings.push(
            `Broker loopback latency is severely degraded: PUBACK=${loopbackProbe.pubackLatencyMs}ms, RTT=${loopbackProbe.roundTripLatencyMs}ms.`,
          );
        } else if (
          loopbackProbe.roundTripLatencyMs !== null &&
          loopbackProbe.roundTripLatencyMs >= 200
        ) {
          hasWarning = true;
          findings.push(
            `Broker loopback RTT is elevated (${loopbackProbe.roundTripLatencyMs}ms; PUBACK=${loopbackProbe.pubackLatencyMs}ms).`,
          );
        }
      }

      const status = backlogDetected ? "BACKLOG_DETECTED" : hasWarning ? "WARNING" : "HEALTHY";
      let diagnosis;
      if (status === "BACKLOG_DETECTED") {
        diagnosis = `MQTT Broker backlog / congestion detected on ${brokerUrl}: ${findings[0]}`;
      } else if (status === "WARNING") {
        diagnosis = `Potential MQTT Broker queue warning or limited visibility on ${brokerUrl}: ${findings[0]}`;
      } else {
        diagnosis = `Healthy: no MQTT message backlog or PUBACK backpressure detected on ${brokerUrl} (loopback RTT=${loopbackProbe.roundTripLatencyMs ?? "—"}ms, queued=${sysMetrics.estimatedQueuedMessages ?? 0}).`;
      }

      return {
        ok: true,
        connected: true,
        status,
        brokerUrl,
        connectLatencyMs: connectedAt ? connectedAt - startedAt : null,
        brokerVersion: sysMetrics.brokerVersion,
        durationSeconds,
        sysMetrics,
        publisherBackpressure,
        loopbackProbe,
        findings,
        recommendations,
        diagnosis,
      };
    };

    connectTimer = setTimeout(() => {
      finish({
        ok: false,
        connected: false,
        status: "UNREACHABLE",
        brokerUrl,
        publisherBackpressure,
        loopbackProbe,
        error: `MQTT connection timed out after ${connectTimeoutMs}ms`,
        findings: [`Unable to connect to MQTT broker at ${brokerUrl} within ${connectTimeoutMs}ms.`],
        recommendations: [
          "Verify the MQTT broker service is running and reachable from the Connector host.",
        ],
        diagnosis: `Broker unreachable at ${brokerUrl} (connection timed out).`,
      });
    }, connectTimeoutMs);

    client.once("connect", () => {
      if (settled) return;
      clearTimeout(connectTimer);
      connectedAt = Date.now();

      // Subscribe to $SYS/# for broker queue/drop/session telemetry
      client.subscribe("$SYS/#", { qos: 0 }, (err, granted) => {
        if (err || (Array.isArray(granted) && granted.some((g) => g?.qos === 128))) {
          sysSubscribeDenied = true;
        }
      });

      // Optionally run a safe QoS 1 non-retained loopback latency probe
      if (includeLoopbackProbe) {
        client.subscribe(probeTopic, { qos: 1 }, (subErr, granted) => {
          if (settled) return;
          if (subErr || (Array.isArray(granted) && granted.some((g) => g?.qos === 128))) {
            loopbackProbe.error = subErr ? subErr.message : "Subscription rejected by Broker ACL";
            return;
          }
          probeSentAt = Date.now();
          client.publish(
            probeTopic,
            JSON.stringify({ probeId, sentAt: probeSentAt }),
            { qos: 1, retain: false },
            (pubErr) => {
              if (settled) return;
              if (pubErr) {
                loopbackProbe.error = pubErr.message;
              } else if (probeSentAt !== null) {
                loopbackProbe.pubackLatencyMs = Math.max(0, Date.now() - probeSentAt);
              }
            },
          );
        });
      }

      samplingTimer = setTimeout(() => {
        finish(buildDiagnosis());
      }, durationSeconds * 1000);
    });

    client.on("message", (topic, payloadBuffer) => {
      if (settled) return;
      const text = payloadBuffer.toString("utf8").trim();
      if (topic === probeTopic && probeSentAt !== null) {
        loopbackProbe.roundTripLatencyMs = Math.max(0, Date.now() - probeSentAt);
        if (loopbackProbe.pubackLatencyMs === null) {
          loopbackProbe.pubackLatencyMs = loopbackProbe.roundTripLatencyMs;
        }
        loopbackProbe.ok = true;
        return;
      }
      if (topic.startsWith("$SYS/")) {
        sysMap.set(topic, text);
      }
    });

    client.once("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      finish({
        ok: false,
        connected: Boolean(connectedAt),
        status: "UNREACHABLE",
        brokerUrl,
        publisherBackpressure,
        loopbackProbe,
        error: message,
        findings: [`MQTT broker error: ${message}`],
        recommendations: ["Check MQTT broker logs, authentication credentials, and port availability."],
        diagnosis: `MQTT broker error on ${brokerUrl}: ${message}`,
      });
    });
  });
}
