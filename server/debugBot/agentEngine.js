import { query as defaultQuery } from "../database.js";
import {
  diagnoseMqttBrokerBacklog,
  diagnoseOpcuaAndSiemens,
  getSystemRuntimeHealth,
  inspectModbusDatablocks,
  subscribeConnectorMqtt,
  testPlcAndMqttConnectivity,
  validateConnectorConfiguration,
} from "./connectorDiagnostics.js";

export const DEBUG_BOT_TOOLS = [
  {
    name: "subscribe_connector_mqtt",
    category: "mqtt",
    summaryEn: "Sample live MQTT topics to verify publish rate, 6-timestamp cycles, and t1–t4 durations.",
    summaryZh: "实时订阅 MQTT Topic 采样，检测推流速率、6 点时间戳闭环及 4 个特征耗时。",
    description:
      "Connect to the configured Connector MQTT broker, subscribe to configured (or specified) topics for 1–10 seconds, measure publish rate/latency, validate 6-timestamp cylinder cycle consistency, and calculate the 4 cylinder stroke durations (t1..t4 in ms).",
    parameters: {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of MQTT topics or wildcards (e.g. ['festo-ax/pni/#', 'festo/plc/#']). Omit to auto-subscribe to all topics configured in Connector.",
        },
        duration_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Sampling duration in seconds (1–10, default 3).",
        },
        max_messages: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum messages to capture before stopping early (default 70).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diagnose_mqtt_broker_backlog",
    category: "mqtt",
    summaryEn: "Detect MQTT broker message backlog via $SYS metrics, Connector PUBACK backpressure, and loopback latency.",
    summaryZh: "诊断 MQTT Broker 是否消息堆积：采集 $SYS 队列/丢包/离线会话指标、发送端背压及环回延迟。",
    description:
      "Diagnose whether MQTT messages are piling up or congested at the broker by combining three live checks: (1) Broker $SYS/# metrics (stored/queued messages excluding retained, dropped messages, disconnected persistent sessions, 1m ingress vs egress rates for Mosquitto/EMQX), (2) Connector publisher backpressure telemetry (in-flight QoS publishes, PUBACK latency, timeouts, socket buffer bytes), and (3) an optional non-retained QoS 1 loopback latency probe.",
    parameters: {
      type: "object",
      properties: {
        duration_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "How many seconds to listen for Broker $SYS/# metrics (1–8, default 2).",
        },
        include_loopback_probe: {
          type: "boolean",
          description:
            "Whether to publish a temporary non-retained QoS 1 probe on festo/connector/debug-probe/* to measure PUBACK and round-trip latency (default true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "inspect_modbus_datablocks",
    category: "modbus",
    summaryEn: "Check how long each active Modbus cylinder datablock has gone without updating data.",
    summaryZh: "读取所有运行中的 Modbus 气缸数据块，分析每个气缸多久没有更新数据。",
    description:
      "Inspect all active Modbus TCP cylinder datablocks (reads every configured cylinder, regardless of count) and analyze how long each cylinder has gone without updating data (staleDurationMs/Seconds, lastDataUpdatedAt, updateCount, neverUpdatedCount).",
    parameters: {
      type: "object",
      properties: {
        plc_id: {
          type: "string",
          description: "Optional Modbus PLC ID to inspect. Omit to inspect all active Modbus pollers.",
        },
        stale_threshold_seconds: {
          type: "number",
          minimum: 1,
          maximum: 86400,
          description:
            "Flag cylinders that have not updated data for at least this many seconds (default 60).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "validate_connector_configuration",
    category: "config",
    summaryEn: "Audit saved config for address overflow, FC03 poll timing, overlaps, and duplicate topics.",
    summaryZh: "静态体检配置：排查寄存器越界、FC03 轮询耗时过紧、地址重叠及重复 Topic。",
    description:
      "Perform a deep static & semantic audit of the saved Connector configuration: verify Modbus address bounds (<=65535), FC03 batch count vs polling interval feasibility, overlapping register ranges, duplicate or invalid MQTT topics, custom layout validity, and duplicate PLC IDs.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "test_plc_and_mqtt_connectivity",
    category: "network",
    summaryEn: "Run live TCP and protocol handshakes (Modbus, OPC UA, MQTT) with latency breakdown.",
    summaryZh: "执行 TCP 与协议层实时握手测试（Modbus / OPC UA / MQTT），定位具体故障层级。",
    description:
      "Run active protocol-level connectivity tests (TCP probe + live Modbus FC03 sample read / OPC UA connect / MQTT broker handshake) with latency breakdown to pinpoint network vs protocol vs authentication failures.",
    parameters: {
      type: "object",
      properties: {
        plc_id: {
          type: "string",
          description: "Optional PLC ID to test only one PLC. Omit to test all saved PLCs.",
        },
        include_mqtt: {
          type: "boolean",
          description: "Whether to also test the configured MQTT broker handshake (default true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_system_runtime_health",
    category: "system",
    summaryEn: "Check PostgreSQL health, process memory/uptime, active pollers, and recent error logs.",
    summaryZh: "查看 PostgreSQL 状态、进程内存与运行时间，以及后端近期报错事件日志。",
    description:
      "Inspect Connector backend runtime health: PostgreSQL connectivity & latency, Node.js uptime and memory usage, active poller counts, and recent backend error/diagnostic events ring buffer.",
    parameters: {
      type: "object",
      properties: {
        event_limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum recent diagnostic events to return (default 25).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diagnose_opcua_and_siemens",
    category: "plc",
    summaryEn: "Inspect Siemens S7 MIP and OPC UA pollers, with optional live OPC UA node browsing.",
    summaryZh: "检查 Siemens S7 MIP 与 OPC UA 轮询状态，支持实时浏览 OPC UA 节点树。",
    description:
      "Inspect saved and live Siemens S7 (MIP data blocks, cylinder/valve identifiers, resolved MQTT topics) and OPC UA pollers, with optional live OPC UA node browsing.",
    parameters: {
      type: "object",
      properties: {
        browse_opcua_plc_id: {
          type: "string",
          description: "Optional OPC UA PLC ID to actively browse nodes on.",
        },
        browse_node_id: {
          type: "string",
          description: "Optional OPC UA NodeId to browse under (omit for ObjectsFolder root).",
        },
      },
      additionalProperties: false,
    },
  },
];

export function listDebugBotTools() {
  return DEBUG_BOT_TOOLS;
}

export async function executeDebugBotTool(toolName, args = {}, context = {}) {
  const {
    queryFn = defaultQuery,
    mqttConnect,
    getPublisherStats,
    probeTcp,
    testModbus,
    testMqtt,
    testOpcua,
    browseOpcua,
    getActivePollers,
    getStatus,
  } = context;

  const startedAt = Date.now();
  try {
    let result;
    if (toolName === "subscribe_connector_mqtt") {
      result = await subscribeConnectorMqtt({
        queryFn,
        args: args ?? {},
        ...(mqttConnect ? { mqttConnect } : {}),
      });
    } else if (toolName === "diagnose_mqtt_broker_backlog") {
      result = await diagnoseMqttBrokerBacklog({
        queryFn,
        args: args ?? {},
        ...(mqttConnect ? { mqttConnect } : {}),
        ...(getPublisherStats ? { getPublisherStats } : {}),
      });
    } else if (toolName === "inspect_modbus_datablocks") {
      result = inspectModbusDatablocks({
        plcId: args?.plc_id ?? null,
        staleThresholdSeconds: args?.stale_threshold_seconds,
        ...(getActivePollers ? { getActivePollers } : {}),
        ...(getStatus ? { getStatus } : {}),
      });
    } else if (toolName === "validate_connector_configuration") {
      result = await validateConnectorConfiguration({ queryFn });
    } else if (toolName === "test_plc_and_mqtt_connectivity") {
      result = await testPlcAndMqttConnectivity({
        queryFn,
        args: args ?? {},
        ...(probeTcp ? { probeTcp } : {}),
        ...(testModbus ? { testModbus } : {}),
        ...(testMqtt ? { testMqtt } : {}),
        ...(testOpcua ? { testOpcua } : {}),
      });
    } else if (toolName === "get_system_runtime_health") {
      result = await getSystemRuntimeHealth({
        queryFn,
        eventLimit: args?.event_limit ?? 25,
      });
    } else if (toolName === "diagnose_opcua_and_siemens") {
      result = await diagnoseOpcuaAndSiemens({
        queryFn,
        args: args ?? {},
        ...(browseOpcua ? { browseOpcua } : {}),
      });
    } else {
      throw new Error(`Unknown Debug Bot tool: ${toolName}`);
    }

    return {
      ok: true,
      tool: toolName,
      arguments: args ?? {},
      durationMs: Date.now() - startedAt,
      result,
    };
  } catch (error) {
    return {
      ok: false,
      tool: toolName,
      arguments: args ?? {},
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSystemPrompt(language = "zh", customPrompt = "") {
  const basePrompt = `You are Debug Bot, the embedded industrial PLC & MQTT diagnostics assistant inside FESTO Connector.
You have live, read-only diagnostic skills covering the full Connector pipeline:
1. subscribe_connector_mqtt: Subscribe to the configured MQTT broker & topics for live payload sampling, publish throughput, and 6-timestamp cylinder cycle verification (t1..t4 durations).
2. diagnose_mqtt_broker_backlog: Diagnose whether MQTT messages are piling up / congested at the Broker by inspecting $SYS/# queue/drop/disconnected-session/rate metrics, Connector publisher PUBACK backpressure & socket buffer, and a QoS 1 loopback latency probe.
3. inspect_modbus_datablocks: Read all live in-memory datablocks across active Modbus pollers (any number of cylinders, no fixed cap) and measure how long each cylinder has gone without updating data (stale duration, last data update time, never-updated status, update count).
4. validate_connector_configuration: Audit the saved configuration for register overflow (>65535), FC03 batch count vs polling interval bottlenecks, overlapping register ranges, and duplicate/invalid MQTT topics.
5. test_plc_and_mqtt_connectivity: Run live protocol handshakes (Modbus read, OPC UA connect, MQTT connect) with TCP vs protocol latency breakdown.
6. get_system_runtime_health: Check PostgreSQL health, Node.js uptime/memory, active pollers, and recent backend diagnostic error events.
7. diagnose_opcua_and_siemens: Inspect Siemens S7 MIP pollers and OPC UA subscriptions (with optional node browsing).

Domain knowledge for Festo Pneumatic Cylinder Datablocks (58 Holding Registers each):
- The 4 characteristic stroke durations computed from 6 key timestamps are:
  * t1 (Extend Reaction) = timestamp_DI_IPos_OFF - timestamp_DO_MCtrl14_ON
  * t2 (Extend Travel) = timestamp_DI_EPos_ON - timestamp_DI_IPos_OFF
  * t3 (Retract Reaction) = timestamp_DI_EPos_OFF - timestamp_DO_MCtrl12_ON
  * t4 (Retract Travel) = timestamp_DI_IPos_ON - timestamp_DI_EPos_OFF
- Connector only publishes a datablock to MQTT (in normal mode) when all 6 timestamps are > 0, form a consistent monotonic cycle (extend-first or retract-first), and all 6 have progressed since the last published cycle.

Guidelines:
- Always call relevant tools to verify live facts before answering; never fabricate PLC statuses, register values, or MQTT messages.
- When doing a full health check, combine validate_connector_configuration, test_plc_and_mqtt_connectivity, inspect_modbus_datablocks, and subscribe_connector_mqtt.
- Be clear, structured, and actionable. Use Markdown headings, bullet points, or compact tables.
- Respond in ${language === "zh" ? "Chinese (简体中文)" : "English"} unless the user writes in another language.`;

  return customPrompt
    ? `${basePrompt}\n\nAdditional customer instructions:\n${customPrompt}`
    : basePrompt;
}

function truncateToolOutputForModel(payload, maxChars = 16000) {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxChars) return serialized;
  return `${serialized.slice(0, maxChars)}... [truncated ${serialized.length - maxChars} chars]`;
}

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "object") return rawArgs;
  try {
    const parsed = JSON.parse(String(rawArgs));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function runOpenAiToolLoop({ messages, config, systemPrompt, context, fetchFn }) {
  const tools = DEBUG_BOT_TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const conversation = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? ""),
    })),
  ];

  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const toolCallsTrace = [];
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let step = 0; step < config.maxToolSteps; step++) {
    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        messages: conversation,
        tools,
        tool_choice: "auto",
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || `LLM API error (HTTP ${response.status})`;
      throw Object.assign(new Error(message), { status: 502 });
    }

    if (data.usage) {
      totalUsage.prompt_tokens += Number(data.usage.prompt_tokens ?? 0);
      totalUsage.completion_tokens += Number(data.usage.completion_tokens ?? 0);
      totalUsage.total_tokens += Number(data.usage.total_tokens ?? 0);
    }

    const assistantMsg = data?.choices?.[0]?.message;
    if (!assistantMsg) {
      throw Object.assign(new Error("LLM returned an empty response."), { status: 502 });
    }

    const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];
    if (toolCalls.length === 0) {
      return {
        reply: String(assistantMsg.content ?? "").trim(),
        model: data.model || config.model,
        toolCalls: toolCallsTrace,
        usage: totalUsage,
      };
    }

    conversation.push({
      role: "assistant",
      content: assistantMsg.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const fnName = call?.function?.name;
      const parsedArgs = parseToolArgs(call?.function?.arguments);
      const execution = await executeDebugBotTool(fnName, parsedArgs, context);
      toolCallsTrace.push(execution);
      conversation.push({
        role: "tool",
        tool_call_id: call.id || `call_${step}_${fnName}`,
        content: truncateToolOutputForModel(
          execution.ok ? execution.result : { error: execution.error },
        ),
      });
    }
  }

  return {
    reply:
      "Reached the maximum tool execution steps. Please review the tool execution trace above or increase Max Tool Steps in Model Settings.",
    model: config.model,
    toolCalls: toolCallsTrace,
    usage: totalUsage,
  };
}

async function runAnthropicToolLoop({ messages, config, systemPrompt, context, fetchFn }) {
  const tools = DEBUG_BOT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const conversation = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? ""),
  }));

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01",
  };

  const toolCallsTrace = [];
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let step = 0; step < config.maxToolSteps; step++) {
    const response = await fetchFn(`${config.baseUrl}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 2048,
        temperature: config.temperature,
        system: systemPrompt,
        messages: conversation,
        tools,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || `Anthropic API error (HTTP ${response.status})`;
      throw Object.assign(new Error(message), { status: 502 });
    }

    if (data.usage) {
      const inputTokens = Number(data.usage.input_tokens ?? 0);
      const outputTokens = Number(data.usage.output_tokens ?? 0);
      totalUsage.prompt_tokens += inputTokens;
      totalUsage.completion_tokens += outputTokens;
      totalUsage.total_tokens += inputTokens + outputTokens;
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const toolUses = blocks.filter((b) => b?.type === "tool_use");

    if (toolUses.length === 0) {
      const text = blocks
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return {
        reply: text,
        model: data.model || config.model,
        toolCalls: toolCallsTrace,
        usage: totalUsage,
      };
    }

    conversation.push({ role: "assistant", content: blocks });

    const toolResults = [];
    for (const use of toolUses) {
      const execution = await executeDebugBotTool(use.name, use.input ?? {}, context);
      toolCallsTrace.push(execution);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: truncateToolOutputForModel(
          execution.ok ? execution.result : { error: execution.error },
        ),
        is_error: !execution.ok,
      });
    }
    conversation.push({ role: "user", content: toolResults });
  }

  return {
    reply:
      "Reached the maximum tool execution steps. Please review the tool execution trace above or increase Max Tool Steps in Model Settings.",
    model: config.model,
    toolCalls: toolCallsTrace,
    usage: totalUsage,
  };
}

export async function runDebugBotChat({
  messages,
  language = "zh",
  config,
  context = {},
  fetchFn = fetch,
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error("At least one user message is required."), { status: 400 });
  }
  const requiresKey = !["ollama", "custom"].includes(config.provider);
  if (requiresKey && !config.apiKey) {
    throw Object.assign(
      new Error(
        "Debug Bot API Key is not configured yet. Open Model Settings to enter your API key or configure a local Ollama endpoint.",
      ),
      { status: 400, code: "DEBUG_BOT_NOT_CONFIGURED" },
    );
  }

  const systemPrompt = buildSystemPrompt(language, config.systemPrompt);
  if (config.apiFormat === "anthropic") {
    return runAnthropicToolLoop({ messages, config, systemPrompt, context, fetchFn });
  }
  return runOpenAiToolLoop({ messages, config, systemPrompt, context, fetchFn });
}
