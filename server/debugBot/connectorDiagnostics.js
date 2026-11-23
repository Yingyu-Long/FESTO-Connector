import net from "node:net";
import mqtt from "mqtt";
import { query as defaultQuery } from "../database.js";
import { testMqttConnection } from "../mqttPublisher.js";
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
    const dataBlocks = Array.isArray(status?.dataBlocks) ? status.dataBlocks : [];

    const cylinders = dataBlocks.map((block, idx) => {
      const firstSeenAt =
        typeof block.firstSeenAt === "number"
          ? block.firstSeenAt
          : typeof status?.updatedAt === "number"
            ? status.updatedAt
            : null;
      const lastDataUpdatedAt =
        typeof block.lastDataUpdatedAt === "number" ? block.lastDataUpdatedAt : null;
      const hasUpdatedSinceStart = lastDataUpdatedAt !== null;
      const referenceTime = lastDataUpdatedAt ?? firstSeenAt;
      const staleDurationMs =
        referenceTime !== null ? Math.max(0, Math.round(now - referenceTime)) : null;
      const staleDurationSeconds =
        staleDurationMs !== null ? Number((staleDurationMs / 1000).toFixed(1)) : null;
      const updateCount =
        typeof block.updateCount === "number"
          ? block.updateCount
          : hasUpdatedSinceStart
            ? 1
            : 0;
      const isStale = staleDurationMs !== null && staleDurationMs >= thresholdMs;

      let freshnessStatus = "NO_DATA";
      if (staleDurationMs !== null) {
        if (isStale) freshnessStatus = "STALE";
        else if (!hasUpdatedSinceStart) freshnessStatus = "NEVER_UPDATED";
        else freshnessStatus = "FRESH";
      }

      return {
        blockIndex: block.index ?? idx,
        startAddress: block.startAddress,
        topic: block.topic,
        partNumber: block.values?.part_number ?? block.values?.sPartnumber ?? null,
        cycleCounter: block.values?.cycle_counter ?? block.values?.udiCycleCounter ?? null,
        firstSeenAt: firstSeenAt !== null ? new Date(firstSeenAt).toISOString() : null,
        lastDataUpdatedAt:
          lastDataUpdatedAt !== null ? new Date(lastDataUpdatedAt).toISOString() : null,
        hasUpdatedSinceStart,
        updateCount,
        staleDurationMs,
        staleDurationSeconds,
        isStale,
        freshnessStatus,
      };
    });

    // Sort longest un-updated first; tie-break by block index.
    cylinders.sort((a, b) => {
      const diff = (b.staleDurationMs ?? -1) - (a.staleDurationMs ?? -1);
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
      lastPollAt: status?.updatedAt ? new Date(status.updatedAt).toISOString() : null,
      checkedAt: new Date(now).toISOString(),
      summary: {
        totalCylinders: cylinders.length,
        staleThresholdSeconds: thresholdSec,
        freshCount: cylinders.filter((c) => c.freshnessStatus === "FRESH").length,
        staleCount: cylinders.filter((c) => c.isStale).length,
        neverUpdatedCount: cylinders.filter((c) => !c.hasUpdatedSinceStart).length,
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
