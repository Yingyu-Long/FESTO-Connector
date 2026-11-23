import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  loadDebugBotConfig,
  maskDebugBotConfigForClient,
  saveDebugBotConfig,
} from "../server/debugBot/configStore.js";
import {
  computeCylinderCycleMetrics,
  diagnoseMqttBrokerBacklog,
  getSystemRuntimeHealth,
  inspectModbusDatablocks,
  subscribeConnectorMqtt,
  testPlcAndMqttConnectivity,
  validateConnectorConfiguration,
} from "../server/debugBot/connectorDiagnostics.js";
import {
  clearDiagnosticEvents,
  recordDiagnosticEvent,
} from "../server/debugBot/diagnosticLog.js";
import {
  executeDebugBotTool,
  listDebugBotTools,
  runDebugBotChat,
} from "../server/debugBot/agentEngine.js";

function makeCylinderValues(base, ratio = 1, extra = {}) {
  const b = BigInt(base);
  const r = BigInt(ratio);
  return {
    timestamp_DO_MCtrl14_ON: String(b),
    timestamp_DO_MCtrl12_OFF: String(b),
    timestamp_DI_IPos_OFF: String(b + 15n * r),
    timestamp_DI_EPos_ON: String(b + 50n * r),
    timestamp_DO_MCtrl12_ON: String(b + 65n * r),
    timestamp_DO_MCtrl14_OFF: String(b + 65n * r),
    timestamp_DI_EPos_OFF: String(b + 80n * r),
    timestamp_DI_IPos_ON: String(b + 110n * r),
    cycle_counter: 42,
    part_number: "CYL-001",
    ...extra,
  };
}

test("Debug Bot configStore persists settings, masks API keys, and preserves secrets on partial updates", async () => {
  let savedRow = null;
  const queryFn = async (sql, params) => {
    if (sql.includes("CREATE TABLE")) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO public.debug_bot_configurations")) {
      savedRow = { configuration: JSON.parse(params[1]) };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT configuration") && sql.includes("debug_bot_configurations")) {
      return { rows: savedRow ? [savedRow] : [], rowCount: savedRow ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };

  const initial = await loadDebugBotConfig({
    queryFn,
    env: { DEBUG_BOT_PROVIDER: "ollama", DEBUG_BOT_MODEL: "qwen2.5:14b" },
  });
  assert.equal(initial.source, "env");
  assert.equal(initial.config.provider, "ollama");
  assert.equal(initial.config.model, "qwen2.5:14b");

  const saved = await saveDebugBotConfig(
    {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "sk-debugbot-secret-12345678",
      model: "deepseek-chat",
    },
    { queryFn, env: {} },
  );
  assert.equal(saved.source, "database");
  assert.equal(saved.config.baseUrl, "https://api.deepseek.com");

  const masked = maskDebugBotConfigForClient(saved.config, saved.source);
  assert.equal(masked.hasApiKey, true);
  assert.equal(masked.apiKeyMasked, "sk-d••••5678");
  assert.equal("apiKey" in masked, false);

  const updated = await saveDebugBotConfig(
    { model: "deepseek-reasoner", temperature: 0.3 },
    { queryFn, env: {} },
  );
  assert.equal(updated.config.apiKey, "sk-debugbot-secret-12345678");
  assert.equal(updated.config.model, "deepseek-reasoner");
});

test("Debug Bot inspects all Modbus cylinder datablocks (any count) and reports stale durations", () => {
  const now = 1_730_000_500_000;
  // Use 100 cylinders (> 66 and > 80) to prove no fixed cylinder cap exists.
  const blocks = Array.from({ length: 100 }, (_, idx) => {
    const baseBlock = {
      index: idx,
      startAddress: idx * 58,
      registerCount: 58,
      topic: `cyl/${idx + 1}`,
      values: makeCylinderValues(10000, 1, { part_number: `CYL-${String(idx + 1).padStart(3, "0")}` }),
      firstSeenAt: now - 300_000,
      lastDataUpdatedAt: now - 5_000,
      updateCount: 12,
    };
    if (idx === 4) {
      // Cylinder 5 -> stale for 180s
      baseBlock.lastDataUpdatedAt = now - 180_000;
      baseBlock.updateCount = 3;
    } else if (idx === 99) {
      // Cylinder 100 -> never updated since poller started 300s ago
      baseBlock.lastDataUpdatedAt = null;
      baseBlock.updateCount = 0;
    }
    return baseBlock;
  });

  const result = inspectModbusDatablocks({
    staleThresholdSeconds: 60,
    nowMs: now,
    getActivePollers: () => [
      {
        id: "Line1_PLC",
        namespace: "modbus",
        config: { host: "10.0.0.10", port: 1502, unitId: 1, readMode: "Read by Datablocks", polling: 500 },
      },
    ],
    getStatus: () => ({ pollingStatus: "HEALTHY", updatedAt: now, dataBlocks: blocks }),
  });

  assert.equal(result.found, true);
  assert.equal(result.pollers.length, 1);
  const poller = result.pollers[0];
  assert.equal(poller.summary.totalCylinders, 100);
  assert.equal(poller.cylinders.length, 100);
  assert.equal(poller.summary.staleCount, 2);
  assert.equal(poller.summary.neverUpdatedCount, 1);
  assert.equal(poller.summary.freshCount, 98);
  assert.equal(poller.summary.maxStaleDurationMs, 300_000);
  // Longest stale cylinders are sorted first
  assert.equal(poller.cylinders[0].blockIndex, 99);
  assert.equal(poller.cylinders[0].hasUpdatedSinceStart, false);
  assert.equal(poller.cylinders[0].staleDurationSeconds, 300);
  assert.equal(poller.cylinders[0].freshnessStatus, "STALE");
  assert.equal(poller.cylinders[1].blockIndex, 4);
  assert.equal(poller.cylinders[1].staleDurationSeconds, 180);
  assert.equal(poller.cylinders[1].freshnessStatus, "STALE");
  assert.equal(poller.cylinders[2].freshnessStatus, "FRESH");
});

test("Debug Bot audits Connector config, tests connectivity, samples MQTT with t1..t4, and inspects runtime health", async () => {
  const savedConfig = {
    id: "cfg-prod",
    mqttMessageHandler: {
      clientId: "edge-1",
      uri: "tcp://10.0.0.50:1883",
      qos: 1,
      basicAuthentication: { username: "edge", password: "secret" },
    },
    messageSources: [
      {
        id: "PLC_A",
        uniqueKey: "modbus-a",
        uri: "modbus.tcp://10.0.0.10:1502",
        configuration: {
          readMode: "Read by Datablocks",
          layoutMode: "standard",
          polling: 200,
          registerCount: 66,
          startAddress: 0,
          blockTopics: Array.from({ length: 66 }, (_, i) =>
            i === 1 ? "festo-ax/pni/cyl-1" : `festo-ax/pni/cyl-${i + 1}`,
          ),
        },
      },
    ],
  };

  const queryFn = async (sql) => {
    if (sql.includes("COUNT(*)")) {
      return { rows: [{ count: 1, latest_updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    if (sql.includes("FROM public.connector_configurations")) {
      return {
        rows: [{ id: savedConfig.id, updated_at: new Date(), configuration: savedConfig }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };

  // 1. Config audit catches duplicate MQTT topic & tight polling interval for 66 DBs (33 FC03 reqs)
  const audit = await validateConnectorConfiguration({ queryFn });
  assert.equal(audit.valid, true);
  assert.ok(audit.warnings.some((w) => w.includes("Duplicate MQTT topic")));
  assert.ok(audit.warnings.some((w) => w.includes("33 FC03 requests")));

  // 2. Active connectivity test
  const connTest = await testPlcAndMqttConnectivity({
    queryFn,
    probeTcp: async () => ({ reachable: true, latencyMs: 3, error: null }),
    testMqtt: async () => true,
    testModbus: async () => Array.from({ length: 66 }, () => ({})),
  });
  assert.equal(connTest.ok, true);
  assert.equal(connTest.mqtt.ok, true);
  assert.equal(connTest.plcs[0].blocksRead, 66);

  // 3. MQTT sampler validates 6 cycle timestamps & computes t1..t4
  const fakeMqttConnect = () => {
    const emitter = new EventEmitter();
    emitter.subscribe = (_topics, _opts, cb) => {
      cb(null);
      setTimeout(() => {
        const vals = makeCylinderValues(1730000000000, 1);
        emitter.emit(
          "message",
          "festo-ax/pni/cyl-1",
          Buffer.from(
            JSON.stringify({
              timestamp_DI_IPos_ON: Number(vals.timestamp_DI_IPos_ON),
              timestamp_DI_IPos_OFF: Number(vals.timestamp_DI_IPos_OFF),
              timestamp_DI_EPos_ON: Number(vals.timestamp_DI_EPos_ON),
              timestamp_DI_EPos_OFF: Number(vals.timestamp_DI_EPos_OFF),
              timestamp_DO_MCtrl12_ON: Number(vals.timestamp_DO_MCtrl12_ON),
              timestamp_DO_MCtrl12_OFF: Number(vals.timestamp_DO_MCtrl12_OFF),
              timestamp_DO_MCtrl14_ON: Number(vals.timestamp_DO_MCtrl14_ON),
              timestamp_DO_MCtrl14_OFF: Number(vals.timestamp_DO_MCtrl14_OFF),
              cycle_counter: 99,
              part_number: "CYL-001",
              isThisAutomaticMode: true,
            }),
          ),
        );
      }, 15);
    };
    emitter.end = () => {};
    setTimeout(() => emitter.emit("connect"), 10);
    return emitter;
  };

  const sample = await subscribeConnectorMqtt({
    queryFn,
    args: { duration_seconds: 1, max_messages: 1 },
    mqttConnect: fakeMqttConnect,
  });
  assert.equal(sample.ok, true);
  assert.equal(sample.topicsSummary[0].cycleConsistent, true);
  assert.deepEqual(sample.topicsSummary[0].durationsMs, {
    extendReactionMs: 15,
    extendTravelMs: 35,
    retractReactionMs: 15,
    retractTravelMs: 30,
    totalMotionMs: 95,
  });

  // 4. Runtime health surfaces diagnostic ring buffer events
  clearDiagnosticEvents();
  recordDiagnosticEvent({ level: "error", component: "modbus", plcId: "PLC_A", message: "Test timeout" });
  const health = await getSystemRuntimeHealth({ queryFn, eventLimit: 10 });
  assert.equal(health.database.ok, true);
  assert.equal(health.recentEvents[0].message, "Test timeout");

  // 5. Cycle metrics helper flags torn cycles cleanly
  const torn = computeCylinderCycleMetrics(
    makeCylinderValues(2000, 1, { timestamp_DO_MCtrl12_ON: "1500" }),
  );
  assert.equal(torn.consistent, false);
  assert.ok(torn.issues.length > 0);
});

test("Debug Bot executes multi-step OpenAI tool-calling loop across Connector skills", async () => {
  assert.equal(listDebugBotTools().length, 7);

  const queryFn = async () => ({ rows: [], rowCount: 0 });
  let calls = 0;
  const mockFetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "inspect_modbus_datablocks",
                      arguments: JSON.stringify({ stale_threshold_seconds: 60 }),
                    },
                  },
                  {
                    id: "call_2",
                    type: "function",
                    function: {
                      name: "validate_connector_configuration",
                      arguments: "{}",
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        model: "deepseek-chat",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Debug Bot audit complete: no Connector configuration saved yet.",
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 18, total_tokens: 168 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const result = await runDebugBotChat({
    messages: [{ role: "user", content: "Audit my Connector setup" }],
    language: "en",
    config: {
      provider: "deepseek",
      apiFormat: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test-key",
      model: "deepseek-chat",
      temperature: 0.2,
      maxToolSteps: 5,
      systemPrompt: "",
    },
    context: { queryFn },
    fetchFn: mockFetch,
  });

  assert.equal(calls, 2);
  assert.equal(result.toolCalls.length, 2);
  assert.equal(result.toolCalls[0].tool, "inspect_modbus_datablocks");
  assert.equal(result.toolCalls[1].tool, "validate_connector_configuration");
  assert.match(result.reply, /Debug Bot audit complete/);

  const unknown = await executeDebugBotTool("does_not_exist", {}, { queryFn });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown Debug Bot tool/);
});

test("Debug Bot diagnoses MQTT broker backlog via $SYS metrics, publisher backpressure, and loopback probe", async () => {
  const savedConfig = {
    id: "cfg-backlog",
    mqttMessageHandler: {
      clientId: "edge-1",
      uri: "tcp://10.0.0.50:1883",
      qos: 1,
    },
    messageSources: [],
  };
  const queryFn = async () => ({
    rows: [{ id: savedConfig.id, updated_at: new Date(), configuration: savedConfig }],
    rowCount: 1,
  });

  // Case 1: Broker with queued backlog, dropped messages, and offline persistent sessions
  const createMockMqtt = (sysPayloads) => () => {
    const emitter = new EventEmitter();
    emitter.subscribe = (topic, _opts, cb) => {
      cb?.(null, [{ topic, qos: 0 }]);
      if (topic === "$SYS/#") {
        setTimeout(() => {
          for (const [k, v] of Object.entries(sysPayloads)) {
            emitter.emit("message", k, Buffer.from(String(v)));
          }
        }, 10);
      }
    };
    emitter.publish = (topic, msg, _opts, cb) => {
      setTimeout(() => {
        cb?.(null);
        emitter.emit("message", topic, Buffer.from(msg));
      }, 15);
    };
    emitter.end = () => {};
    setTimeout(() => emitter.emit("connect"), 5);
    return emitter;
  };

  const backlogResult = await diagnoseMqttBrokerBacklog({
    queryFn,
    args: { duration_seconds: 1, include_loopback_probe: true },
    mqttConnect: createMockMqtt({
      "$SYS/broker/version": "mosquitto version 2.0.18",
      "$SYS/broker/store/messages/count": "540",
      "$SYS/broker/retained messages/count": "40",
      "$SYS/broker/publish/messages/dropped": "12",
      "$SYS/broker/clients/connected": "3",
      "$SYS/broker/clients/disconnected": "2",
      "$SYS/broker/load/publish/received/1min": "600.0",
      "$SYS/broker/load/publish/sent/1min": "80.0",
    }),
    getPublisherStats: () => ({
      inFlightCount: 0,
      maxInFlightCount: 2,
      totalPublished: 500,
      totalErrors: 0,
      totalTimeouts: 0,
      avgPublishLatencyMs: 6,
      p95PublishLatencyMs: 10,
      maxPublishLatencyMs: 14,
      lastPublishLatencyMs: 5,
      recentPublishRatePerSec: 10,
      activeClientCount: 1,
      connectedClientCount: 1,
      totalOutgoingBufferBytes: 0,
      lastPublishAt: new Date().toISOString(),
      lastErrorAt: null,
      lastErrorMessage: null,
    }),
  });

  assert.equal(backlogResult.ok, true);
  assert.equal(backlogResult.status, "BACKLOG_DETECTED");
  assert.equal(backlogResult.sysMetrics.estimatedQueuedMessages, 500);
  assert.equal(backlogResult.sysMetrics.droppedMessages, 12);
  assert.equal(backlogResult.sysMetrics.disconnectedClients, 2);
  assert.equal(backlogResult.loopbackProbe.ok, true);
  assert.ok(backlogResult.findings.some((f) => f.includes("500")));
  assert.ok(backlogResult.findings.some((f) => f.includes("12 dropped")));

  // Case 2: Healthy broker (stored == retained => 0 queued backlog)
  const healthyResult = await diagnoseMqttBrokerBacklog({
    queryFn,
    args: { duration_seconds: 1, include_loopback_probe: true },
    mqttConnect: createMockMqtt({
      "$SYS/broker/version": "mosquitto version 2.0.18",
      "$SYS/broker/store/messages/count": "38",
      "$SYS/broker/retained messages/count": "38",
      "$SYS/broker/publish/messages/dropped": "0",
      "$SYS/broker/clients/connected": "4",
      "$SYS/broker/clients/disconnected": "0",
      "$SYS/broker/load/publish/received/1min": "120.0",
      "$SYS/broker/load/publish/sent/1min": "120.0",
    }),
    getPublisherStats: () => ({
      inFlightCount: 0,
      maxInFlightCount: 1,
      totalPublished: 120,
      totalErrors: 0,
      totalTimeouts: 0,
      avgPublishLatencyMs: 4,
      p95PublishLatencyMs: 6,
      maxPublishLatencyMs: 8,
      lastPublishLatencyMs: 4,
      recentPublishRatePerSec: 2,
      activeClientCount: 1,
      connectedClientCount: 1,
      totalOutgoingBufferBytes: 0,
      lastPublishAt: new Date().toISOString(),
      lastErrorAt: null,
      lastErrorMessage: null,
    }),
  });

  assert.equal(healthyResult.ok, true);
  assert.equal(healthyResult.status, "HEALTHY");
  assert.equal(healthyResult.sysMetrics.estimatedQueuedMessages, 0);
  assert.equal(healthyResult.loopbackProbe.ok, true);
});
