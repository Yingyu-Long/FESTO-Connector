import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useAppShell } from "../appShellContext";
import "./debugBot.css";

interface DebugBotConfigClient {
  provider: string;
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  temperature: number;
  maxToolSteps: number;
  systemPrompt: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  requiresApiKey: boolean;
  configured: boolean;
  source: "database" | "env";
}

interface ProviderPreset {
  id: string;
  label: string;
  apiFormat: "openai" | "anthropic";
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey: boolean;
}

interface DebugBotToolDefinition {
  name: string;
  category: string;
  description: string;
  summaryEn?: string;
  summaryZh?: string;
}

interface ToolCallTrace {
  ok: boolean;
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  result?: unknown;
  error?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallTrace[];
  model?: string;
  error?: boolean;
  createdAt: string;
}

interface CylinderPublishGate {
  enforced: boolean;
  eligible: boolean;
  consistent: boolean;
  progressed: boolean;
  reason: string;
  detail: string;
  zeroFields?: string[];
  changedTimestampFields?: string[];
  unchangedTimestampFields?: string[];
}

interface CylinderFreshnessItem {
  blockIndex: number;
  startAddress: number;
  topic: string;
  partNumber: string | null;
  cycleCounter: unknown;
  firstSeenAt: string | null;
  lastDataUpdatedAt: string | null;
  lastValidCycleAt?: string | null;
  lastRawChangedAt?: string | null;
  lastRejectedChangeAt?: string | null;
  hasUpdatedSinceStart: boolean;
  updateCount: number;
  validCycleCount?: number;
  rawChangeCount?: number;
  publishCount?: number;
  staleDurationMs: number | null;
  staleDurationSeconds: number | null;
  isStale: boolean;
  freshnessStatus:
    | "FRESH"
    | "STALE"
    | "NEVER_UPDATED"
    | "NO_DATA"
    | "READ_FAILED"
    | "REJECTED_CHANGE";
  nonFreshReason?: "READ_FAILED" | "DATA_UNCHANGED" | "PARTIAL_CHANGE_REJECTED" | null;
  reasonDetail?: string | null;
  changedFields?: string[];
  publishGate?: CylinderPublishGate | null;
}

interface DatablocksInspectResult {
  found: boolean;
  message?: string;
  pollers: Array<{
    plcId: string;
    namespace: string;
    endpoint: string;
    endian: string;
    pollingMs: number;
    pollingStatus: string;
    lastError?: string | null;
    lastReadError?: string | null;
    lastPublishError?: string | null;
    consecutiveReadErrors?: number;
    lastReadAt?: string | null;
    lastPollAt?: string | null;
    checkedAt?: string;
    summary: {
      totalCylinders: number;
      staleThresholdSeconds: number;
      freshCount: number;
      staleCount: number;
      neverUpdatedCount: number;
      readFailedCount?: number;
      unchangedCount?: number;
      rejectedChangeCount?: number;
      maxStaleDurationMs: number | null;
      maxStaleDurationSeconds: number | null;
    };
    cylinders: CylinderFreshnessItem[];
  }>;
}

interface ModbusPollerTarget {
  plcId: string;
  namespace: string;
  endpoint: string;
  layoutMode: string;
  endian: string;
  pollingMs: number;
  pollingStatus: string;
  blockCount: number;
  mqttConfigured: boolean;
}

interface TestModeBlockResult {
  blockIndex: number;
  startAddress: number;
  topic: string;
  partNumber: string | null;
  cycleCounter: unknown;
  published: boolean;
  publishError: string | null;
  normalGatePassed: boolean;
  normalGateReason: string;
  normalGateDetail: string;
  payload: Record<string, unknown> | null;
}

interface TestModePublishResult {
  ok: boolean;
  found: boolean;
  durationSeconds?: number;
  elapsedMs?: number;
  totalPublished?: number;
  totalFailed?: number;
  message?: string;
  error?: string;
  availablePollers?: ModbusPollerTarget[];
  results?: Array<{
    plcId: string;
    namespace: string;
    endpoint: string;
    layoutMode: string;
    endian: string;
    mqttConfigured: boolean;
    brokerUrl: string | null;
    readOk: boolean;
    readLatencyMs: number | null;
    readError: string | null;
    rounds: number;
    totalBlocks: number;
    publishedCount: number;
    failedCount: number;
    blockedInNormalCount: number;
    blocks: TestModeBlockResult[];
  }>;
}

interface MqttSubscribeResult {
  ok: boolean;
  connected: boolean;
  brokerUrl?: string;
  connectLatencyMs?: number | null;
  firstMessageLatencyMs?: number | null;
  subscribedTopics?: string[];
  durationSeconds?: number;
  totalMessages?: number;
  uniqueTopicCount?: number;
  messagesPerSecond?: number;
  topicsSummary?: Array<{
    topic: string;
    messageCount: number;
    payloadType: string;
    validJson: boolean;
    cycleCounter?: unknown;
    populatedTimestamps?: number;
    cycleConsistent?: boolean;
    durationsMs?: {
      extendReactionMs: number | string;
      extendTravelMs: number | string;
      retractReactionMs: number | string;
      retractTravelMs: number | string;
      totalMotionMs: number | string;
    };
    anomalies?: string[];
    latestSample?: unknown;
  }>;
  warnings?: string[];
  diagnosis?: string;
  error?: string;
}

interface MqttBacklogResult {
  ok: boolean;
  connected: boolean;
  status: "HEALTHY" | "WARNING" | "BACKLOG_DETECTED" | "UNREACHABLE";
  brokerUrl?: string;
  connectLatencyMs?: number | null;
  brokerVersion?: string | null;
  durationSeconds?: number;
  sysMetrics?: {
    available: boolean;
    topicCount: number;
    storedMessages: number | null;
    retainedMessages: number | null;
    estimatedQueuedMessages: number | null;
    storedBytes: number | null;
    droppedMessages: number | null;
    droppedRate1m: number | null;
    connectedClients: number | null;
    disconnectedClients: number | null;
    subscriptionsCount: number | null;
    receivedRate1m: number | null;
    sentRate1m: number | null;
    publishReceivedRate1m: number | null;
    publishSentRate1m: number | null;
    rawSample: Record<string, string>;
  };
  publisherBackpressure?: {
    inFlightCount: number;
    maxInFlightCount: number;
    totalPublished: number;
    totalErrors: number;
    totalTimeouts: number;
    avgPublishLatencyMs: number | null;
    p95PublishLatencyMs: number | null;
    maxPublishLatencyMs: number | null;
    recentPublishRatePerSec: number;
    totalOutgoingBufferBytes: number;
    lastPublishAt: string | null;
    lastErrorMessage: string | null;
  };
  loopbackProbe?: {
    enabled: boolean;
    ok: boolean;
    topic: string | null;
    pubackLatencyMs: number | null;
    roundTripLatencyMs: number | null;
    error: string | null;
  };
  findings?: string[];
  recommendations?: string[];
  diagnosis?: string;
  error?: string;
}

interface ConfigAuditResult {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  errors: string[];
  warnings: string[];
  checks: Array<{ target: string; status: string; detail: string }>;
}

interface SystemHealthResult {
  nodeVersion: string;
  uptimeSeconds: number;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number };
  database: {
    ok: boolean;
    latencyMs: number | null;
    savedConfigurations: number;
    error: string | null;
  };
  activePollers: {
    modbusCount: number;
    modbusIds: string[];
    opcuaCount: number;
    opcuaIds: string[];
  };
  recentEvents: Array<{
    timestamp: string;
    level: string;
    component: string;
    plcId: string | null;
    message: string;
  }>;
}

type DiagTab = "freshness" | "test-mode" | "mqtt" | "backlog" | "audit";
type FreshnessFilter = "all" | "non_fresh" | "read_failed" | "unchanged" | "rejected" | "fresh";
type StatusTone = "ok" | "warn" | "error" | null;

function Icon({ name, size = 16, className = "" }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
  switch (name) {
    case "bot":
      return (
        <svg {...common}>
          <rect x="3" y="8" width="18" height="12" rx="3" />
          <path d="M12 8V4H8" />
          <circle cx="9" cy="14" r="1" fill="currentColor" />
          <circle cx="15" cy="14" r="1" fill="currentColor" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15.5 14" />
        </svg>
      );
    case "layers":
      return (
        <svg {...common}>
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 12 12 17 22 12" />
          <polyline points="2 17 12 22 22 17" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
        </svg>
      );
    case "radio":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2" />
          <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
          <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
        </svg>
      );
    case "wrench":
      return (
        <svg {...common}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <polyline points="9 12 11.5 14.5 16 9.5" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      );
    case "spinner":
      return (
        <svg {...common} className={`dbot-spin ${className}`}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      );
    case "zap":
      return (
        <svg {...common}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "arrow-right":
      return (
        <svg {...common}>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="13 6 19 12 13 18" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

function renderInlineMarkdown(text: string) {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((token, idx) => {
    if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
      return (
        <code key={idx} className="dbot-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith("**") && token.endsWith("**") && token.length >= 4) {
      return <strong key={idx}>{token.slice(2, -2)}</strong>;
    }
    return <span key={idx}>{token}</span>;
  });
}

function FormattedMessage({ content }: { content: string }) {
  const blocks = content.split(/```([\s\S]*?)```/g);
  return (
    <div className="dbot-markdown">
      {blocks.map((block, blockIdx) => {
        if (blockIdx % 2 === 1) {
          const firstNewline = block.indexOf("\n");
          const codeBody = firstNewline >= 0 ? block.slice(firstNewline + 1) : block;
          return (
            <pre key={blockIdx} className="dbot-code-block">
              <code>{codeBody.trimEnd()}</code>
            </pre>
          );
        }

        const lines = block.split("\n");
        const elements: ReactNode[] = [];
        let listItems: string[] = [];

        const flushList = (keyPrefix: string) => {
          if (listItems.length === 0) return;
          elements.push(
            <ul key={`${keyPrefix}-ul`} className="dbot-md-list">
              {listItems.map((item, idx) => (
                <li key={idx}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>,
          );
          listItems = [];
        };

        lines.forEach((rawLine, lineIdx) => {
          const trimmed = rawLine.trim();
          if (!trimmed) {
            flushList(`${blockIdx}-${lineIdx}`);
            return;
          }
          if (/^#{1,4}\s+/.test(trimmed)) {
            flushList(`${blockIdx}-${lineIdx}`);
            elements.push(
              <h4 key={`${blockIdx}-${lineIdx}`} className="dbot-md-heading">
                {renderInlineMarkdown(trimmed.replace(/^#{1,4}\s+/, ""))}
              </h4>,
            );
            return;
          }
          if (/^[-*•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
            listItems.push(trimmed.replace(/^(?:[-*•]|\d+\.)\s+/, ""));
            return;
          }
          flushList(`${blockIdx}-${lineIdx}`);
          elements.push(
            <p key={`${blockIdx}-${lineIdx}`} className="dbot-md-p">
              {renderInlineMarkdown(trimmed)}
            </p>,
          );
        });
        flushList(`${blockIdx}-end`);
        return <div key={blockIdx}>{elements}</div>;
      })}
    </div>
  );
}

function formatStaleDuration(ms: number | null, zh: boolean): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return zh ? "< 1 秒" : "< 1s";
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    return zh ? `${totalSec.toFixed(1)} 秒` : `${totalSec.toFixed(1)}s`;
  }
  const sec = Math.floor(totalSec) % 60;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    return zh ? `${totalMin} 分 ${sec} 秒` : `${totalMin}m ${sec}s`;
  }
  const min = totalMin % 60;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours < 24) {
    return zh ? `${totalHours} 小时 ${min} 分` : `${totalHours}h ${min}m`;
  }
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  return zh ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`;
}

function formatLocalTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour12: false });
}

function formatUptime(seconds: number, zh: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return zh ? `${mins} 分` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return zh ? `${hours} 小时 ${remMin} 分` : `${hours}h ${remMin}m`;
}

function formatGateReason(
  reason: string | undefined,
  detail: string | undefined,
  zh: boolean,
  gate?: CylinderPublishGate | null,
): string {
  if (!reason) return detail || "—";
  switch (reason) {
    case "VALID_CYCLE":
      return zh ? "符合正常发送标准" : "Meets publish standard";
    case "NO_CYCLE_GATING":
      return zh ? "自定义布局（无 6 时间戳门控）" : "Custom layout (no cycle gating)";
    case "ZERO_TIMESTAMPS": {
      const zeros = gate?.zeroFields ?? [];
      if (zeros.length >= 6) {
        return zh ? "6 个关键时间戳全为 0（未初始化）" : "All 6 cycle timestamps are 0";
      }
      return zh
        ? `存在 0 值时间戳（${zeros.length > 0 ? zeros.join(", ") : detail || "部分未赋值"}）`
        : detail || "Contains zero cycle timestamps";
    }
    case "INVALID_TIMESTAMPS":
      return zh ? `时间戳格式非法（${detail || ""}）` : detail || "Invalid timestamp values";
    case "INCONSISTENT_CYCLE":
      return zh
        ? `6 个时间戳不构成完整单调周期（${detail || "动作中或字节序异常"}）`
        : detail || "Inconsistent / torn 6-timestamp cycle";
    case "PARTIAL_TIMESTAMP_PROGRESSION": {
      const changed = gate?.changedTimestampFields ?? [];
      return zh
        ? `仅部分时间戳变化（${changed.length > 0 ? changed.join(", ") : "未满 6 项"}），未构成完整新周期`
        : detail || "Only a subset of the 6 timestamps changed";
    }
    case "CYCLE_NOT_PROGRESSED":
      return zh ? "6 个关键时间戳较上次未推进" : "All 6 cycle timestamps unchanged since last publish";
    case "PAYLOAD_ERROR":
      return zh
        ? "时间戳超出 JSON 安全整数（常见于字节序 Big/Little-Endian 选错）"
        : detail || "Unsafe JSON timestamp (check Endian setting)";
    default:
      return detail || reason;
  }
}

function formatCylinderDiagnosis(c: CylinderFreshnessItem, zh: boolean): string {
  if (c.freshnessStatus === "FRESH") {
    const count = c.publishCount ?? c.validCycleCount ?? c.updateCount;
    return zh ? `符合发送标准 · 已有效更新 ${count} 次` : `Valid cycle · ${count} valid updates`;
  }
  if (c.nonFreshReason === "READ_FAILED" || c.freshnessStatus === "READ_FAILED" || c.freshnessStatus === "NO_DATA") {
    return c.reasonDetail
      ? zh
        ? `Modbus 读取失败：${c.reasonDetail}`
        : `Modbus read failed: ${c.reasonDetail}`
      : zh
        ? "尚未从 PLC 成功读到数据"
        : "No data read from PLC yet";
  }
  if (c.nonFreshReason === "PARTIAL_CHANGE_REJECTED" || c.freshnessStatus === "REJECTED_CHANGE") {
    const fields = (c.changedFields ?? []).map((f) => f.replace(/^timestamp_/, ""));
    const fieldText =
      fields.length > 0
        ? zh
          ? `变动字段 [${fields.slice(0, 3).join(", ")}${fields.length > 3 ? ` 等 ${fields.length} 项` : ""}]，`
          : `Changed [${fields.slice(0, 3).join(", ")}${fields.length > 3 ? ` +${fields.length - 3}` : ""}] — `
        : "";
    const gateText = formatGateReason(c.publishGate?.reason, c.publishGate?.detail, zh, c.publishGate);
    return `${fieldText}${gateText}`;
  }
  // DATA_UNCHANGED
  if (c.publishGate?.enforced && !c.publishGate.consistent) {
    const gateHint = formatGateReason(c.publishGate.reason, c.publishGate.detail, zh, c.publishGate);
    return zh
      ? `Modbus 读取正常，数据未变化（且当前值：${gateHint}）`
      : `PLC read OK, data unchanged (current snapshot: ${gateHint})`;
  }
  return zh ? "Modbus 读取正常，寄存器值无变化" : "PLC read OK, register values unchanged";
}

function ToolTraceCard({ trace, zh }: { trace: ToolCallTrace; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="dbot-trace-item">
      <button
        type="button"
        className="dbot-trace-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="dbot-trace-caret">{expanded ? "▾" : "▸"}</span>
        <span className="dbot-trace-name">{trace.tool}</span>
        <span className={`dbot-trace-badge ${trace.ok ? "is-ok" : "is-error"}`}>
          {trace.ok ? (zh ? "成功" : "OK") : zh ? "异常" : "Error"}
        </span>
        <span className="dbot-trace-time">{trace.durationMs} ms</span>
      </button>
      {expanded && (
        <div className="dbot-trace-body">
          {Object.keys(trace.arguments || {}).length > 0 && (
            <div className="dbot-trace-section">
              <div className="dbot-trace-label">{zh ? "调用参数" : "Arguments"}</div>
              <pre>{JSON.stringify(trace.arguments, null, 2)}</pre>
            </div>
          )}
          <div className="dbot-trace-section">
            <div className="dbot-trace-label">
              {trace.ok ? (zh ? "返回数据" : "Result") : zh ? "错误信息" : "Error"}
            </div>
            <pre>{trace.ok ? JSON.stringify(trace.result, null, 2) : trace.error}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DebugBot() {
  const { language, debugBotView: activeView, setDebugBotView: setActiveView } = useAppShell();
  const zh = language === "zh";

  const [config, setConfig] = useState<DebugBotConfigClient | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [tools, setTools] = useState<DebugBotToolDefinition[]>([]);
  const [loadError, setLoadError] = useState("");

  // Settings form state
  const [provider, setProvider] = useState("deepseek");
  const [apiFormat, setApiFormat] = useState<"openai" | "anthropic">("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [model, setModel] = useState("deepseek-chat");
  const [temperature, setTemperature] = useState("0.2");
  const [maxToolSteps, setMaxToolSteps] = useState("8");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [testingSettings, setTestingSettings] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<{
    type: "ok" | "error";
    text: string;
  } | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Quick Diagnostics workbench state (works with or without LLM API key)
  const [activeDiagTab, setActiveDiagTab] = useState<DiagTab>("freshness");
  const [staleThresholdSeconds, setStaleThresholdSeconds] = useState(60);
  const [datablocksFilter, setDatablocksFilter] = useState<FreshnessFilter>("all");
  const [datablocksSort, setDatablocksSort] = useState<"stale" | "index">("stale");
  const [datablocksDiag, setDatablocksDiag] = useState<DatablocksInspectResult | null>(null);
  const [datablocksLoading, setDatablocksLoading] = useState(false);

  // Test Mode (on-demand diagnostic publish, no persistent switch)
  const [modbusTargets, setModbusTargets] = useState<ModbusPollerTarget[]>([]);
  const [testModePlcId, setTestModePlcId] = useState("");
  const [testModeDuration, setTestModeDuration] = useState(0);
  const [testModeResult, setTestModeResult] = useState<TestModePublishResult | null>(null);
  const [testModeLoading, setTestModeLoading] = useState(false);

  const [mqttTopicInput, setMqttTopicInput] = useState("");
  const [mqttDuration, setMqttDuration] = useState(3);
  const [mqttDiag, setMqttDiag] = useState<MqttSubscribeResult | null>(null);
  const [mqttLoading, setMqttLoading] = useState(false);

  // MQTT Broker Backlog Diagnostics state
  const [backlogDuration, setBacklogDuration] = useState(2);
  const [backlogLoopback, setBacklogLoopback] = useState(true);
  const [backlogDiag, setBacklogDiag] = useState<MqttBacklogResult | null>(null);
  const [backlogLoading, setBacklogLoading] = useState(false);

  // Config Audit + System Health state
  const [auditDiag, setAuditDiag] = useState<ConfigAuditResult | null>(null);
  const [healthDiag, setHealthDiag] = useState<SystemHealthResult | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);

  const loadInitialState = useCallback(async () => {
    setLoadError("");
    try {
      const [cfgRes, toolsRes] = await Promise.all([
        fetch("/api/debug-bot/config", { cache: "no-store" }),
        fetch("/api/debug-bot/tools", { cache: "no-store" }),
      ]);
      if (!cfgRes.ok || !toolsRes.ok) {
        const status = !toolsRes.ok ? toolsRes.status : cfgRes.status;
        setLoadError(
          status === 404
            ? zh
              ? "后端尚未加载 Debug Bot 接口（HTTP 404），请重启后端服务（npm run server:dev）。"
              : "Backend does not expose /api/debug-bot yet (HTTP 404). Please restart the backend server (npm run server:dev)."
            : zh
              ? `无法连接后端服务（HTTP ${status}），请确认已运行 npm run server:dev（端口 3001）。`
              : `Unable to reach backend service (HTTP ${status}). Make sure npm run server:dev is running on port 3001.`,
        );
        return;
      }
      const cfgData = (await cfgRes.json()) as {
        config: DebugBotConfigClient;
        presets: ProviderPreset[];
      };
      const toolsData = (await toolsRes.json()) as { tools: DebugBotToolDefinition[] };
      setConfig(cfgData.config);
      setPresets(cfgData.presets ?? []);
      setProvider(cfgData.config.provider);
      setApiFormat(cfgData.config.apiFormat);
      setBaseUrl(cfgData.config.baseUrl);
      setModel(cfgData.config.model);
      setTemperature(String(cfgData.config.temperature ?? 0.2));
      setMaxToolSteps(String(cfgData.config.maxToolSteps ?? 8));
      setSystemPrompt(cfgData.config.systemPrompt ?? "");
      setTools(toolsData.tools ?? []);
    } catch {
      setLoadError(
        zh
          ? "后端服务未启动（localhost:3001 无法连接）。请运行 npm run server:dev 启动后端后点击重试。"
          : "Backend server is not running (cannot reach localhost:3001). Start it with npm run server:dev and retry.",
      );
    }
  }, [zh]);

  const loadModbusTargets = useCallback(async () => {
    try {
      const res = await fetch("/api/debug-bot/modbus-pollers", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { pollers?: ModbusPollerTarget[] };
      setModbusTargets(data.pollers ?? []);
    } catch {
      // Ignore silent refresh failures; main loadError banner handles unreachable backend.
    }
  }, []);

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

  useEffect(() => {
    if (activeView === "diagnostics") {
      void loadModbusTargets();
    }
  }, [activeView, activeDiagTab, loadModbusTargets]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  const selectPreset = (preset: ProviderPreset) => {
    setProvider(preset.id);
    setApiFormat(preset.apiFormat);
    setBaseUrl(preset.defaultBaseUrl);
    setModel(preset.defaultModel);
    setSettingsNotice(null);
  };

  async function handleSaveSettings(event: FormEvent) {
    event.preventDefault();
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/debug-bot/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiFormat,
          baseUrl,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          model,
          temperature: Number(temperature),
          maxToolSteps: Number(maxToolSteps),
          systemPrompt,
        }),
      });
      const data = (await res.json()) as {
        saved?: boolean;
        config?: DebugBotConfigClient;
        error?: string;
      };
      if (!res.ok || !data.config) {
        throw new Error(data.error || "Failed to save Debug Bot configuration");
      }
      setConfig(data.config);
      setApiKeyDraft("");
      setSettingsNotice({
        type: "ok",
        text: zh
          ? "配置已保存到 PostgreSQL 并立即生效。"
          : "Configuration saved to PostgreSQL and activated.",
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleClearApiKey() {
    setSavingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/debug-bot/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearApiKey: true }),
      });
      const data = (await res.json()) as { config?: DebugBotConfigClient; error?: string };
      if (!res.ok || !data.config) throw new Error(data.error || "Failed to clear API key");
      setConfig(data.config);
      setApiKeyDraft("");
      setSettingsNotice({
        type: "ok",
        text: zh ? "已清除保存的 API Key。" : "Saved API key cleared.",
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleTestConnection() {
    setTestingSettings(true);
    setSettingsNotice(null);
    try {
      const res = await fetch("/api/debug-bot/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiFormat,
          baseUrl,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          model,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Connection test failed");
      }
      setSettingsNotice({
        type: "ok",
        text: zh
          ? `连接成功：${data.model}（${data.latencyMs} ms）`
          : `Connected: ${data.model} (${data.latencyMs} ms)`,
      });
    } catch (err) {
      setSettingsNotice({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingSettings(false);
    }
  }

  async function sendMessage(promptText?: string) {
    const content = (promptText ?? input).trim();
    if (!content || sending) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    if (!promptText) setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/debug-bot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language,
          messages: nextHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = (await res.json()) as {
        reply?: string;
        toolCalls?: ToolCallTrace[];
        model?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Debug Bot failed to respond.");
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: data.reply || (zh ? "（未返回文本内容）" : "(Empty response)"),
          toolCalls: data.toolCalls ?? [],
          model: data.model,
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "assistant",
          content: err instanceof Error ? err.message : String(err),
          error: true,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function callTool<T>(tool: string, args: Record<string, unknown> = {}) {
    const res = await fetch("/api/debug-bot/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, arguments: args }),
    });
    return (await res.json()) as { ok: boolean; result?: T; error?: string };
  }

  async function runDatablocksInspect() {
    setDatablocksLoading(true);
    try {
      const data = await callTool<DatablocksInspectResult>("inspect_modbus_datablocks", {
        stale_threshold_seconds: staleThresholdSeconds,
      });
      if (data.result) setDatablocksDiag(data.result);
    } finally {
      setDatablocksLoading(false);
    }
  }

  async function runTestModePublish() {
    setTestModeLoading(true);
    try {
      const res = await fetch("/api/debug-bot/test-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(testModePlcId ? { plcId: testModePlcId } : {}),
          durationSeconds: testModeDuration,
        }),
      });
      const data = (await res.json()) as TestModePublishResult;
      setTestModeResult(data);
      if (Array.isArray(data.availablePollers)) {
        setModbusTargets(data.availablePollers);
      }
    } catch (err) {
      setTestModeResult({
        ok: false,
        found: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestModeLoading(false);
    }
  }

  async function runMqttSample() {
    setMqttLoading(true);
    try {
      const topics = mqttTopicInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const data = await callTool<MqttSubscribeResult>("subscribe_connector_mqtt", {
        duration_seconds: mqttDuration,
        ...(topics.length > 0 ? { topics } : {}),
      });
      if (data.result) {
        setMqttDiag(data.result);
      } else {
        setMqttDiag({ ok: false, connected: false, error: data.error || "Sampling failed" });
      }
    } finally {
      setMqttLoading(false);
    }
  }

  async function runBrokerBacklogCheck() {
    setBacklogLoading(true);
    try {
      const data = await callTool<MqttBacklogResult>("diagnose_mqtt_broker_backlog", {
        duration_seconds: backlogDuration,
        include_loopback_probe: backlogLoopback,
      });
      if (data.result) {
        setBacklogDiag(data.result);
      } else {
        setBacklogDiag({
          ok: false,
          connected: false,
          status: "UNREACHABLE",
          error: data.error || "Broker backlog diagnostic failed",
        });
      }
    } finally {
      setBacklogLoading(false);
    }
  }

  async function runAuditAndHealth() {
    setAuditLoading(true);
    try {
      const [auditRes, healthRes] = await Promise.all([
        callTool<ConfigAuditResult>("validate_connector_configuration"),
        callTool<SystemHealthResult>("get_system_runtime_health", { event_limit: 20 }),
      ]);
      if (auditRes.result) setAuditDiag(auditRes.result);
      if (healthRes.result) setHealthDiag(healthRes.result);
    } finally {
      setAuditLoading(false);
    }
  }

  const quickPrompts = zh
    ? [
        {
          icon: "clock",
          label: "检测气缸数据更新时长",
          hint: "排查长时间未更新或从未更新的气缸",
          prompt:
            "请检查所有运行中的 Modbus 气缸 Datablock，列出每个气缸多久没有更新数据，重点标出长时间未更新或从未更新的气缸。",
        },
        {
          icon: "layers",
          label: "诊断 MQTT Broker 堆积",
          hint: "检查 $SYS 队列、发送背压与环回延迟",
          prompt:
            "请诊断当前 MQTT Broker 是否存在消息堆积或发送背压，检查 $SYS 队列、丢包、离线持久会话、Connector PUBACK 延迟及环回延迟并给出排查建议。",
        },
        {
          icon: "radio",
          label: "MQTT 推流与特征时间校验",
          hint: "采样 3 秒核查 6 个时间戳与 t1~t4",
          prompt:
            "请体检当前 Connector 的 PLC 配置，并订阅已配置的 MQTT Topic 采样 3 秒，核查气缸 6 个时间戳与 4 个特征时间是否全部正常。",
        },
        {
          icon: "shield",
          label: "配置体检与运行日志排查",
          hint: "检查地址边界、轮询耗时与后端告警",
          prompt:
            "请执行配置体检（检查地址越界、FC03 分批耗时与轮询周期匹配度、重复 Topic）并查看 PostgreSQL、内存和近期后端报错事件。",
        },
      ]
    : [
        {
          icon: "clock",
          label: "Check Cylinder Freshness",
          hint: "Find stale or never-updated datablocks",
          prompt:
            "Inspect all active Modbus cylinder datablocks and report how long each cylinder has gone without updating data, highlighting any stale or never-updated cylinders.",
        },
        {
          icon: "layers",
          label: "Diagnose Broker Backlog",
          hint: "Inspect $SYS queue, backpressure & RTT",
          prompt:
            "Check whether MQTT messages are piling up at the Broker by inspecting $SYS queue/dropped/offline-session metrics, Connector PUBACK backpressure, and loopback latency.",
        },
        {
          icon: "radio",
          label: "Sample Live MQTT Stream",
          hint: "Verify 6 timestamps & t1..t4 durations",
          prompt:
            "Validate saved Connector PLC & MQTT configurations and subscribe to configured MQTT topics for 3 seconds to verify 6-timestamp cylinder cycles and t1..t4 durations.",
        },
        {
          icon: "shield",
          label: "Audit Config & Runtime Health",
          hint: "Check bounds, poll timing & backend logs",
          prompt:
            "Validate the saved Connector configuration (register bounds, FC03 batch timing, duplicate topics) and inspect PostgreSQL health, uptime, and recent backend diagnostic errors.",
        },
      ];

  const freshnessTone: StatusTone = !datablocksDiag
    ? null
    : !datablocksDiag.found
      ? "warn"
      : datablocksDiag.pollers.some(
            (p) => (p.summary.readFailedCount ?? 0) > 0 || p.summary.staleCount > 0,
          )
        ? "error"
        : datablocksDiag.pollers.some(
              (p) =>
                (p.summary.rejectedChangeCount ?? 0) > 0 || (p.summary.unchangedCount ?? 0) > 0,
            )
          ? "warn"
          : "ok";

  const testModeTone: StatusTone = !testModeResult
    ? null
    : !testModeResult.found
      ? "warn"
      : testModeResult.ok
        ? "ok"
        : (testModeResult.totalPublished ?? 0) > 0
          ? "warn"
          : "error";

  const mqttTone: StatusTone = !mqttDiag
    ? null
    : mqttDiag.ok && (mqttDiag.totalMessages ?? 0) > 0
      ? "ok"
      : "warn";

  const backlogTone: StatusTone = !backlogDiag
    ? null
    : backlogDiag.status === "HEALTHY"
      ? "ok"
      : backlogDiag.status === "WARNING"
        ? "warn"
        : "error";

  const auditTone: StatusTone =
    !auditDiag && !healthDiag
      ? null
      : (auditDiag && auditDiag.errorCount > 0) || (healthDiag && !healthDiag.database.ok)
        ? "error"
        : auditDiag && auditDiag.warningCount > 0
          ? "warn"
          : "ok";

  const diagTabs: Array<{
    id: DiagTab;
    icon: string;
    label: string;
    tone: StatusTone;
    loading: boolean;
  }> = [
    {
      id: "freshness",
      icon: "clock",
      label: zh ? "气缸更新监测" : "Freshness",
      tone: freshnessTone,
      loading: datablocksLoading,
    },
    {
      id: "test-mode",
      icon: "zap",
      label: "Test Mode",
      tone: testModeTone,
      loading: testModeLoading,
    },
    {
      id: "mqtt",
      icon: "radio",
      label: zh ? "MQTT 采样" : "MQTT Sampler",
      tone: mqttTone,
      loading: mqttLoading,
    },
    {
      id: "backlog",
      icon: "layers",
      label: zh ? "Broker 堆积" : "Broker Backlog",
      tone: backlogTone,
      loading: backlogLoading,
    },
    {
      id: "audit",
      icon: "shield",
      label: zh ? "配置与体检" : "Config & Health",
      tone: auditTone,
      loading: auditLoading,
    },
  ];

  return (
    <div className="unified-module-container dbot-scope">
      <div className="dbot-page-head">
        <h1>Debug Bot</h1>
        {config &&
          (config.configured ? (
            <span className="unified-status-pill is-connected">
              <i />
              {zh ? "模型已就绪" : "Model Ready"}
            </span>
          ) : (
            <button
              type="button"
              className="dbot-status-btn"
              onClick={() => setActiveView("settings")}
            >
              <i />
              <span>{zh ? "未配置 API Key" : "API Key Needed"}</span>
            </button>
          ))}
      </div>

      {loadError && (
        <div className="dbot-error-box dbot-load-error">
          <span>{loadError}</span>
          <button
            type="button"
            className="dbot-btn-secondary dbot-btn-sm"
            onClick={() => void loadInitialState()}
          >
            {zh ? "重试" : "Retry"}
          </button>
        </div>
      )}

      {/* VIEW 1: AI CHAT */}
      {activeView === "chat" && (
        <div className="dbot-chat-card">
          <div className="dbot-chat-topbar">
            <button
              type="button"
              className="dbot-chat-skill-pill"
              onClick={() => setActiveView("settings")}
              title={zh ? "查看已挂载的诊断技能" : "View registered diagnostic skills"}
            >
              <i />
              <span>
                {tools.length > 0
                  ? zh
                    ? `${tools.length} 个诊断技能已就绪`
                    : `${tools.length} diagnostic skills ready`
                  : zh
                    ? "Connector 诊断技能"
                    : "Connector skills"}
              </span>
            </button>
            {messages.length > 0 && (
              <button
                type="button"
                className="dbot-ghost-btn"
                onClick={() => setMessages([])}
                disabled={sending}
              >
                <Icon name="trash" size={14} />
                <span>{zh ? "清空对话" : "Clear"}</span>
              </button>
            )}
          </div>

          {config && !config.configured && (
            <div className="dbot-inline-notice">
              <span className="dbot-inline-notice-text">
                {zh
                  ? "未配置 API Key，配置后可启用 AI 对话；实时巡检工具可直接免 Key 使用。"
                  : "No API key configured. Set up a model to chat, or use Quick Diagnostics directly."}
              </span>
              <div className="dbot-inline-notice-links">
                <button
                  type="button"
                  className="dbot-text-link"
                  onClick={() => setActiveView("diagnostics")}
                >
                  {zh ? "实时巡检" : "Quick Diagnostics"}
                </button>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  className="dbot-text-link is-strong"
                  onClick={() => setActiveView("settings")}
                >
                  {zh ? "去配置" : "Configure"}
                </button>
              </div>
            </div>
          )}

          <div className="dbot-chat-messages">
            {messages.length === 0 ? (
              <div className="dbot-empty-state">
                <div className="dbot-empty-icon">
                  <Icon name="bot" size={22} />
                </div>
                <h3>{zh ? "Connector 智能排障" : "Connector Diagnostics"}</h3>
                <p>
                  {zh
                    ? "输入现场问题或选择下方快捷项，自动调用诊断技能检查气缸数据、Broker 堆积与配置状态。"
                    : "Describe a PLC or MQTT issue, or pick a quick check to inspect cylinders, broker backlog, and config health."}
                </p>
                <div className="dbot-quick-prompts">
                  {quickPrompts.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      className="dbot-prompt-card"
                      disabled={sending}
                      onClick={() => void sendMessage(item.prompt)}
                    >
                      <span className="dbot-prompt-icon">
                        <Icon name={item.icon} size={15} />
                      </span>
                      <span className="dbot-prompt-copy">
                        <strong>{item.label}</strong>
                        <small>{item.hint}</small>
                      </span>
                      <Icon name="arrow-right" size={14} className="dbot-prompt-arrow" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="dbot-msg-stream">
                {messages.map((msg) => (
                  <div key={msg.id} className={`dbot-msg-row is-${msg.role}`}>
                    <div className={`dbot-msg-bubble ${msg.error ? "is-error" : ""}`}>
                      {msg.role === "assistant" && (
                        <div className="dbot-msg-role-head">
                          <span className="dbot-msg-role-tag">Debug Bot</span>
                          {msg.model && <span className="dbot-msg-model">{msg.model}</span>}
                        </div>
                      )}
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <div className="dbot-trace-list">
                          {msg.toolCalls.map((trace, idx) => (
                            <ToolTraceCard key={`${msg.id}-t-${idx}`} trace={trace} zh={zh} />
                          ))}
                        </div>
                      )}
                      {msg.role === "assistant" ? (
                        <FormattedMessage content={msg.content} />
                      ) : (
                        <div className="dbot-user-text">{msg.content}</div>
                      )}
                    </div>
                  </div>
                ))}

                {sending && (
                  <div className="dbot-msg-row is-assistant">
                    <div className="dbot-msg-bubble is-thinking">
                      <Icon name="spinner" size={15} />
                      <span>
                        {zh
                          ? "正在调用诊断技能分析实时数据…"
                          : "Running diagnostic skills on live data…"}
                      </span>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          <div className="dbot-composer-wrap">
            <form
              className="dbot-composer-box"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMessage();
              }}
            >
              <textarea
                rows={2}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={
                  zh
                    ? "输入排查问题，例如：哪些气缸超过 5 分钟没更新？或 Broker 是否堆积…"
                    : "Ask Debug Bot to check stale cylinders, broker backlog, or sample live MQTT…"
                }
                disabled={sending}
              />
              <button
                type="submit"
                className="dbot-send-btn"
                disabled={sending || !input.trim()}
                aria-label={zh ? "发送消息" : "Send message"}
              >
                <Icon name={sending ? "spinner" : "send"} size={15} />
                <span>{zh ? "发送" : "Send"}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {/* VIEW 2: QUICK DIAGNOSTICS WORKBENCH (NO LLM KEY NEEDED) */}
      {activeView === "diagnostics" && (
        <div className="dbot-diag-workspace">
          <div className="dbot-diag-tabs" role="tablist" aria-label={zh ? "巡检工具" : "Diagnostic tools"}>
            {diagTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeDiagTab === tab.id}
                className={`dbot-diag-tab ${activeDiagTab === tab.id ? "is-active" : ""}`}
                onClick={() => setActiveDiagTab(tab.id)}
              >
                <Icon name={tab.loading ? "spinner" : tab.icon} size={15} />
                <span>{tab.label}</span>
                {tab.tone && <i className={`dbot-tab-dot is-${tab.tone}`} aria-hidden="true" />}
              </button>
            ))}
          </div>

          {/* Tool 1: Modbus Cylinder Data Freshness Monitor */}
          {activeDiagTab === "freshness" && (
            <section className="dbot-panel">
              <div className="dbot-panel-head">
                <div className="dbot-panel-title-block">
                  <h2>{zh ? "Modbus 气缸数据新鲜度监测" : "Modbus Cylinder Data Freshness"}</h2>
                  <p>
                    {zh
                      ? "检测每个气缸是否为 Fresh 数据，并自动分辨：读不上数据、数据未更新，或部分数据已变化但不符合新发送标准。"
                      : "Check cylinder freshness and distinguish PLC read failures, static unchanged data, and partial changes blocked by publish rules."}
                  </p>
                </div>
                <button
                  type="button"
                  className="dbot-btn-primary"
                  disabled={datablocksLoading}
                  onClick={() => void runDatablocksInspect()}
                >
                  <Icon name={datablocksLoading ? "spinner" : "play"} size={14} />
                  {datablocksLoading
                    ? zh
                      ? "检测中…"
                      : "Checking…"
                    : zh
                      ? "开始检测"
                      : "Check Freshness"}
                </button>
              </div>

              <div className="dbot-toolbar">
                <label className="dbot-field-inline is-md">
                  <span>{zh ? "超时阈值" : "Stale Threshold"}</span>
                  <select
                    value={staleThresholdSeconds}
                    onChange={(e) => setStaleThresholdSeconds(Number(e.target.value))}
                  >
                    <option value={10}>{zh ? "10 秒" : "10s"}</option>
                    <option value={30}>{zh ? "30 秒" : "30s"}</option>
                    <option value={60}>{zh ? "1 分钟 (60s)" : "1 min (60s)"}</option>
                    <option value={300}>{zh ? "5 分钟" : "5 min"}</option>
                    <option value={900}>{zh ? "15 分钟" : "15 min"}</option>
                    <option value={3600}>{zh ? "1 小时" : "1 hour"}</option>
                  </select>
                </label>
                <label className="dbot-field-inline is-lg">
                  <span>{zh ? "筛选分类" : "Filter"}</span>
                  <select
                    value={datablocksFilter}
                    onChange={(e) => setDatablocksFilter(e.target.value as FreshnessFilter)}
                  >
                    <option value="all">{zh ? "全部气缸" : "All Cylinders"}</option>
                    <option value="non_fresh">{zh ? "全部非 Fresh 气缸" : "All Non-Fresh"}</option>
                    <option value="read_failed">{zh ? "仅看：读不上数据" : "Read Failed Only"}</option>
                    <option value="unchanged">{zh ? "仅看：数据未更新" : "Data Unchanged Only"}</option>
                    <option value="rejected">
                      {zh ? "仅看：有变化但不符标准" : "Gate Blocked Only"}
                    </option>
                    <option value="fresh">{zh ? "仅看：正常更新 (Fresh)" : "Fresh Only"}</option>
                  </select>
                </label>
                <label className="dbot-field-inline is-lg">
                  <span>{zh ? "排序方式" : "Sort By"}</span>
                  <select
                    value={datablocksSort}
                    onChange={(e) => setDatablocksSort(e.target.value as "stale" | "index")}
                  >
                    <option value="stale">{zh ? "未更新时长（最长优先）" : "Longest Stale First"}</option>
                    <option value="index">{zh ? "按气缸序号 (DB #)" : "Cylinder Index (DB #)"}</option>
                  </select>
                </label>
              </div>

              {!datablocksDiag ? (
                <div className="dbot-panel-empty">
                  <Icon name="clock" size={20} />
                  <span>
                    {zh
                      ? "点击右上角「开始检测」分析气缸新鲜度及非 Fresh 根因。"
                      : "Click Check Freshness to inspect cylinder freshness and non-fresh root causes."}
                  </span>
                </div>
              ) : !datablocksDiag.found ? (
                <div className="dbot-warning-box">{datablocksDiag.message}</div>
              ) : (
                <div className="dbot-diag-body">
                  {datablocksDiag.pollers.map((p) => {
                    const readFailedCount =
                      p.summary.readFailedCount ??
                      p.cylinders.filter((c) => c.nonFreshReason === "READ_FAILED").length;
                    const unchangedCount =
                      p.summary.unchangedCount ??
                      p.cylinders.filter((c) => c.nonFreshReason === "DATA_UNCHANGED").length;
                    const rejectedChangeCount =
                      p.summary.rejectedChangeCount ??
                      p.cylinders.filter((c) => c.nonFreshReason === "PARTIAL_CHANGE_REJECTED")
                        .length;

                    const visibleCylinders = p.cylinders
                      .filter((c) => {
                        if (datablocksFilter === "all") return true;
                        if (datablocksFilter === "fresh") return c.freshnessStatus === "FRESH";
                        if (datablocksFilter === "non_fresh") return c.freshnessStatus !== "FRESH";
                        if (datablocksFilter === "read_failed")
                          return c.nonFreshReason === "READ_FAILED";
                        if (datablocksFilter === "unchanged")
                          return c.nonFreshReason === "DATA_UNCHANGED";
                        if (datablocksFilter === "rejected")
                          return c.nonFreshReason === "PARTIAL_CHANGE_REJECTED";
                        return true;
                      })
                      .sort((a, b) => {
                        if (datablocksSort === "index") return a.blockIndex - b.blockIndex;
                        const aVal =
                          a.staleDurationMs ??
                          (a.nonFreshReason === "READ_FAILED" ? Number.MAX_SAFE_INTEGER : -1);
                        const bVal =
                          b.staleDurationMs ??
                          (b.nonFreshReason === "READ_FAILED" ? Number.MAX_SAFE_INTEGER : -1);
                        const diff = bVal - aVal;
                        return diff !== 0 ? diff : a.blockIndex - b.blockIndex;
                      });

                    return (
                      <div key={`${p.namespace}-${p.plcId}`} className="dbot-poller-block">
                        <div className="dbot-poller-meta">
                          <div className="dbot-poller-id">
                            <strong>{p.plcId}</strong>
                            <code>{p.endpoint}</code>
                            <span className="dbot-meta-chip">{p.endian}</span>
                          </div>
                          <div className="dbot-poller-runtime">
                            <span
                              className={`dbot-pill ${
                                p.pollingStatus === "HEALTHY"
                                  ? "is-ok"
                                  : p.pollingStatus === "MQTT_NOT_CONFIGURED"
                                    ? "is-warn"
                                    : "is-error"
                              }`}
                            >
                              {p.pollingStatus}
                            </span>
                            <span className="dbot-meta-muted">{p.pollingMs} ms</span>
                          </div>
                        </div>

                        {p.lastReadError && (
                          <div className="dbot-error-box">
                            <strong>
                              {zh ? "Modbus 读取失败（压根读不上数据）：" : "Modbus Read Failed: "}
                            </strong>
                            <span>{p.lastReadError}</span>
                          </div>
                        )}

                        {!p.lastReadError && p.lastPublishError && (
                          <div className="dbot-warning-box">
                            <strong>
                              {zh ? "Modbus 读取正常，但 MQTT 推送失败：" : "Modbus Read OK, MQTT Publish Failed: "}
                            </strong>
                            <span>{p.lastPublishError}</span>
                          </div>
                        )}

                        <div className="dbot-kpi-grid cols-4">
                          <div className="dbot-kpi-card">
                            <span>{zh ? "正常更新 (Fresh)" : "Fresh"}</span>
                            <strong className={p.summary.freshCount > 0 ? "is-ok" : ""}>
                              {p.summary.freshCount} / {p.summary.totalCylinders}
                            </strong>
                            <small>
                              {zh
                                ? `阈值 < ${p.summary.staleThresholdSeconds}s`
                                : `Within ${p.summary.staleThresholdSeconds}s`}
                            </small>
                          </div>
                          <div className="dbot-kpi-card">
                            <span>{zh ? "读不上数据" : "Read Failed"}</span>
                            <strong className={readFailedCount > 0 ? "is-danger" : ""}>
                              {readFailedCount}
                            </strong>
                            <small>
                              {zh ? "PLC 断连 / 读取报错" : "PLC unreachable / read error"}
                            </small>
                          </div>
                          <div className="dbot-kpi-card">
                            <span>{zh ? "数据未更新" : "Data Unchanged"}</span>
                            <strong className={unchangedCount > 0 ? "is-warn-num" : ""}>
                              {unchangedCount}
                            </strong>
                            <small>
                              {zh ? "最长未更新" : "Longest"}:{" "}
                              {formatStaleDuration(p.summary.maxStaleDurationMs, zh)}
                            </small>
                          </div>
                          <div className="dbot-kpi-card">
                            <span>{zh ? "有变化但不符标准" : "Changed · Gate Blocked"}</span>
                            <strong className={rejectedChangeCount > 0 ? "is-violet" : ""}>
                              {rejectedChangeCount}
                            </strong>
                            <small>
                              {zh ? "被 6 时间戳门控拦截" : "Blocked by publish criteria"}
                            </small>
                          </div>
                        </div>

                        {p.summary.totalCylinders === 0 ? (
                          <div className="dbot-warning-box">
                            {zh
                              ? `PLC「${p.plcId}」当前没有配置 Datablock 气缸（可能为寄存器单读模式）。`
                              : `PLC "${p.plcId}" has 0 configured datablock cylinders (may be in register mode).`}
                          </div>
                        ) : visibleCylinders.length === 0 ? (
                          <div className="dbot-diagnosis-banner is-ok">
                            <strong>
                              {zh
                                ? "当前筛选条件下没有匹配的气缸。"
                                : "No cylinders match the current filter."}
                            </strong>
                          </div>
                        ) : (
                          <div className="dbot-table-wrap dbot-table-scroll">
                            <table className="dbot-table">
                              <thead>
                                <tr>
                                  <th>DB #</th>
                                  <th>Topic / Part</th>
                                  <th>{zh ? "状态分类" : "Status"}</th>
                                  <th>{zh ? "原因诊断" : "Diagnosis"}</th>
                                  <th>{zh ? "未更新时长" : "Stale For"}</th>
                                  <th>{zh ? "有效更新" : "Valid Updates"}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleCylinders.map((c) => {
                                  const isFresh = c.freshnessStatus === "FRESH";
                                  const isReadFailed = c.nonFreshReason === "READ_FAILED";
                                  const isRejected =
                                    c.nonFreshReason === "PARTIAL_CHANGE_REJECTED";
                                  const pillClass = isFresh
                                    ? "is-ok"
                                    : isReadFailed
                                      ? "is-error"
                                      : isRejected
                                        ? "is-violet"
                                        : c.isStale
                                          ? "is-warn"
                                          : "is-neutral";
                                  const statusText = isFresh
                                    ? zh
                                      ? "正常更新"
                                      : "Fresh"
                                    : isReadFailed
                                      ? zh
                                        ? "读不上数据"
                                        : "Read Failed"
                                      : isRejected
                                        ? zh
                                          ? "有变化但不符标准"
                                          : "Gate Blocked"
                                        : c.isStale
                                          ? zh
                                            ? "数据未更新（超时）"
                                            : "Unchanged (Stale)"
                                          : zh
                                            ? "数据未更新"
                                            : "Unchanged";
                                  const durationText = formatStaleDuration(c.staleDurationMs, zh);

                                  return (
                                    <tr key={`${p.namespace}-${p.plcId}-${c.blockIndex}`}>
                                      <td className="dbot-num">#{c.blockIndex + 1}</td>
                                      <td>
                                        {c.partNumber && (
                                          <strong className="dbot-part-tag">{c.partNumber}</strong>
                                        )}
                                        <code className="dbot-topic-code">{c.topic}</code>
                                      </td>
                                      <td>
                                        <span className={`dbot-pill ${pillClass}`}>
                                          {statusText}
                                        </span>
                                      </td>
                                      <td className="dbot-reason-cell">
                                        {formatCylinderDiagnosis(c, zh)}
                                      </td>
                                      <td className="dbot-num">
                                        <strong>
                                          {!c.hasUpdatedSinceStart && c.staleDurationMs !== null
                                            ? `≥ ${durationText}`
                                            : durationText}
                                        </strong>
                                        {isRejected && c.lastRawChangedAt && (
                                          <div className="dbot-cell-sub">
                                            {zh ? "原始变化" : "Raw"}:{" "}
                                            {formatLocalTime(c.lastRawChangedAt)}
                                          </div>
                                        )}
                                      </td>
                                      <td className="dbot-num dbot-muted-cell">
                                        <div>{c.validCycleCount ?? c.updateCount}</div>
                                        <div className="dbot-cell-sub">
                                          {c.lastValidCycleAt ?? c.lastDataUpdatedAt
                                            ? formatLocalTime(
                                                c.lastValidCycleAt ?? c.lastDataUpdatedAt,
                                              )
                                            : c.firstSeenAt
                                              ? zh
                                                ? `始于 ${formatLocalTime(c.firstSeenAt)}`
                                                : `since ${formatLocalTime(c.firstSeenAt)}`
                                              : "—"}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Tool 2: On-demand Modbus Test Mode Publish (No persistent switch) */}
          {activeDiagTab === "test-mode" && (
            <section className="dbot-panel">
              <div className="dbot-panel-head">
                <div className="dbot-panel-title-block">
                  <h2>{zh ? "Modbus Test Mode 推流" : "Modbus Test Mode Publish"}</h2>
                  <p>
                    {zh
                      ? "按需跳过 6 点时间戳发送门控，直接将当前读取到的气缸数据推流到 MQTT Broker；执行结束后自动恢复正常模式，无需手动开关。"
                      : "Bypass 6-timestamp cycle gating on demand and publish current Modbus datablocks directly to MQTT. Stops automatically without a persistent switch."}
                  </p>
                </div>
                <button
                  type="button"
                  className="dbot-btn-primary"
                  disabled={testModeLoading}
                  onClick={() => void runTestModePublish()}
                >
                  <Icon name={testModeLoading ? "spinner" : "zap"} size={14} />
                  {testModeLoading
                    ? testModeDuration > 0
                      ? zh
                        ? `推流中 (${testModeDuration}s)…`
                        : `Publishing (${testModeDuration}s)…`
                      : zh
                        ? "推流中…"
                        : "Publishing…"
                    : zh
                      ? "开始测试推流"
                      : "Run Test Publish"}
                </button>
              </div>

              <div className="dbot-toolbar">
                <label className="dbot-field-inline is-grow">
                  <span>{zh ? "目标 PLC" : "Target PLC"}</span>
                  <select
                    value={testModePlcId}
                    onChange={(e) => setTestModePlcId(e.target.value)}
                  >
                    <option value="">
                      {zh
                        ? `全部运行中的 Modbus Datablock PLC (${modbusTargets.length})`
                        : `All active Modbus Datablock PLCs (${modbusTargets.length})`}
                    </option>
                    {modbusTargets.map((target) => (
                      <option key={`${target.namespace}-${target.plcId}`} value={target.plcId}>
                        {target.plcId} · {target.endpoint} ({target.blockCount} DB)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dbot-field-inline is-lg">
                  <span>{zh ? "推流方式" : "Run Mode"}</span>
                  <select
                    value={testModeDuration}
                    onChange={(e) => setTestModeDuration(Number(e.target.value))}
                  >
                    <option value={0}>{zh ? "单次推送（1 轮）" : "Single shot (1 round)"}</option>
                    <option value={3}>{zh ? "连续推送 3 秒" : "Continuous 3s"}</option>
                    <option value={5}>{zh ? "连续推送 5 秒" : "Continuous 5s"}</option>
                    <option value={10}>{zh ? "连续推送 10 秒" : "Continuous 10s"}</option>
                  </select>
                </label>
              </div>

              {!testModeResult ? (
                <div className="dbot-panel-empty">
                  <Icon name="zap" size={20} />
                  <span>
                    {zh
                      ? "点击右上角「开始测试推流」执行无门控测试发送，并对比正常模式的拦截原因。"
                      : "Click Run Test Publish to send current datablocks without cycle gating and inspect normal-mode gate verdicts."}
                  </span>
                </div>
              ) : !testModeResult.found ? (
                <div className="dbot-warning-box">
                  {testModeResult.message || testModeResult.error}
                </div>
              ) : (
                <div className="dbot-diag-body">
                  {(testModeResult.results ?? []).map((plc) => (
                    <div key={`${plc.namespace}-${plc.plcId}`} className="dbot-poller-block">
                      <div className="dbot-poller-meta">
                        <div className="dbot-poller-id">
                          <strong>{plc.plcId}</strong>
                          <code>{plc.endpoint}</code>
                          <span className="dbot-meta-chip">{plc.endian}</span>
                          {plc.brokerUrl && <span className="dbot-meta-muted">→ {plc.brokerUrl}</span>}
                        </div>
                        <div className="dbot-poller-runtime">
                          <span
                            className={`dbot-pill ${
                              plc.readOk && plc.failedCount === 0
                                ? "is-ok"
                                : plc.readOk
                                  ? "is-warn"
                                  : "is-error"
                            }`}
                          >
                            {!plc.readOk
                              ? zh
                                ? "读取失败"
                                : "Read Failed"
                              : plc.failedCount === 0
                                ? zh
                                  ? "推流完成"
                                  : "Published"
                                : zh
                                  ? "部分失败"
                                  : "Partial"}
                          </span>
                          {plc.readLatencyMs !== null && (
                            <span className="dbot-meta-muted">{plc.readLatencyMs} ms</span>
                          )}
                        </div>
                      </div>

                      {!plc.readOk && plc.readError && (
                        <div className="dbot-error-box">
                          <strong>{zh ? "Modbus 读取失败：" : "Modbus Read Failed: "}</strong>
                          <span>{plc.readError}</span>
                        </div>
                      )}

                      {plc.readOk && !plc.mqttConfigured && (
                        <div className="dbot-warning-box">
                          {zh
                            ? "已完成 Modbus 实时读取，但尚未配置 MQTT Broker，因此未向 Broker 发送消息。"
                            : "Modbus read succeeded, but no MQTT broker is configured so messages were not published."}
                        </div>
                      )}

                      <div className="dbot-kpi-grid cols-4">
                        <div className="dbot-kpi-card">
                          <span>{zh ? "执行轮次" : "Rounds"}</span>
                          <strong>{plc.rounds}</strong>
                          <small>
                            {plc.totalBlocks} {zh ? "个气缸/轮" : "blocks/round"}
                          </small>
                        </div>
                        <div className="dbot-kpi-card">
                          <span>{zh ? "测试推流成功" : "Published"}</span>
                          <strong className={plc.publishedCount > 0 ? "is-ok" : ""}>
                            {plc.publishedCount}
                          </strong>
                        </div>
                        <div className="dbot-kpi-card">
                          <span>{zh ? "发送失败" : "Failed"}</span>
                          <strong className={plc.failedCount > 0 ? "is-danger" : ""}>
                            {plc.failedCount}
                          </strong>
                        </div>
                        <div className="dbot-kpi-card">
                          <span>{zh ? "正常模式会被拦截" : "Blocked in Normal Mode"}</span>
                          <strong className={plc.blockedInNormalCount > 0 ? "is-violet" : ""}>
                            {plc.blockedInNormalCount} / {plc.totalBlocks}
                          </strong>
                        </div>
                      </div>

                      {plc.blocks.length > 0 && (
                        <div className="dbot-table-wrap dbot-table-scroll">
                          <table className="dbot-table">
                            <thead>
                              <tr>
                                <th>DB #</th>
                                <th>Topic / Part</th>
                                <th>{zh ? "测试推流" : "Test Publish"}</th>
                                <th>{zh ? "正常模式判定" : "Normal Mode Gate"}</th>
                                <th>Payload</th>
                              </tr>
                            </thead>
                            <tbody>
                              {plc.blocks.map((b) => (
                                <tr key={`${plc.namespace}-${plc.plcId}-${b.blockIndex}`}>
                                  <td className="dbot-num">#{b.blockIndex + 1}</td>
                                  <td>
                                    {b.partNumber && (
                                      <strong className="dbot-part-tag">{b.partNumber}</strong>
                                    )}
                                    <code className="dbot-topic-code">{b.topic}</code>
                                  </td>
                                  <td>
                                    {b.published ? (
                                      <span className="dbot-pill is-ok">
                                        {zh ? "已发送" : "Sent"}
                                      </span>
                                    ) : (
                                      <div>
                                        <span className="dbot-pill is-error">
                                          {zh ? "未发送" : "Failed"}
                                        </span>
                                        {b.publishError && (
                                          <div className="dbot-cell-sub">{b.publishError}</div>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                  <td className="dbot-reason-cell">
                                    <span
                                      className={`dbot-pill ${b.normalGatePassed ? "is-ok" : "is-violet"}`}
                                      style={{ marginRight: 6 }}
                                    >
                                      {b.normalGatePassed
                                        ? zh
                                          ? "符合标准"
                                          : "Pass"
                                        : zh
                                          ? "会被拦截"
                                          : "Blocked"}
                                    </span>
                                    <span>
                                      {formatGateReason(
                                        b.normalGateReason,
                                        b.normalGateDetail,
                                        zh,
                                      )}
                                    </span>
                                  </td>
                                  <td>
                                    {b.payload ? (
                                      <details className="dbot-inline-payload">
                                        <summary>{zh ? "查看 JSON" : "JSON"}</summary>
                                        <pre>{JSON.stringify(b.payload, null, 2)}</pre>
                                      </details>
                                    ) : (
                                      <span className="dbot-muted-cell">—</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Tool 2: Live MQTT Sampler */}
          {activeDiagTab === "mqtt" && (
            <section className="dbot-panel">
              <div className="dbot-panel-head">
                <div className="dbot-panel-title-block">
                  <h2>
                    {zh ? "MQTT 实时订阅采样与特征时间校验" : "Live MQTT Sampler & Stroke Validation"}
                  </h2>
                  <p>
                    {zh
                      ? "实时订阅 Broker 主题，校验 JSON 结构、6 个时间戳完整性与 t1–t4 动作耗时。"
                      : "Subscribe to live MQTT topics to validate JSON schema, 6 timestamps, and t1–t4 stroke durations."}
                  </p>
                </div>
                <button
                  type="button"
                  className="dbot-btn-primary"
                  disabled={mqttLoading}
                  onClick={() => void runMqttSample()}
                >
                  <Icon name={mqttLoading ? "spinner" : "radio"} size={14} />
                  {mqttLoading
                    ? zh
                      ? `采样中 (${mqttDuration}s)…`
                      : `Sampling (${mqttDuration}s)…`
                    : zh
                      ? "开始采样"
                      : "Start Sample"}
                </button>
              </div>

              <div className="dbot-toolbar">
                <label className="dbot-field-inline is-grow">
                  <span>
                    {zh
                      ? "自定义 Topic（留空自动读取已配置主题）"
                      : "Topic Filter (blank = auto from Connector)"}
                  </span>
                  <input
                    type="text"
                    value={mqttTopicInput}
                    onChange={(e) => setMqttTopicInput(e.target.value)}
                    placeholder="festo-ax/pni/#, festo/plc/#"
                  />
                </label>
                <label className="dbot-field-inline is-sm">
                  <span>{zh ? "采样时长" : "Duration"}</span>
                  <select
                    value={mqttDuration}
                    onChange={(e) => setMqttDuration(Number(e.target.value))}
                  >
                    <option value={2}>2s</option>
                    <option value={3}>3s</option>
                    <option value={5}>5s</option>
                    <option value={8}>8s</option>
                  </select>
                </label>
              </div>

              {!mqttDiag ? (
                <div className="dbot-panel-empty">
                  <Icon name="radio" size={20} />
                  <span>
                    {zh
                      ? "点击「开始采样」捕获实时 MQTT 报文并校验气缸动作周期。"
                      : "Click Start Sample to capture live MQTT payloads and validate cylinder cycles."}
                  </span>
                </div>
              ) : (
                <div className="dbot-diag-body">
                  <div
                    className={`dbot-diagnosis-banner ${mqttDiag.ok && (mqttDiag.totalMessages ?? 0) > 0 ? "is-ok" : "is-warn"}`}
                  >
                    <strong>{mqttDiag.diagnosis || mqttDiag.error}</strong>
                  </div>

                  {mqttDiag.connected && (
                    <div className="dbot-kpi-grid cols-3">
                      <div className="dbot-kpi-card">
                        <span>Broker</span>
                        <strong className="dbot-mono">{mqttDiag.brokerUrl}</strong>
                        <small>
                          {zh ? "连接耗时" : "Connect"}: {mqttDiag.connectLatencyMs ?? "—"} ms
                        </small>
                      </div>
                      <div className="dbot-kpi-card">
                        <span>{zh ? "收到消息数" : "Messages"}</span>
                        <strong>
                          {mqttDiag.totalMessages ?? 0}
                          <em className="dbot-kpi-sub">({mqttDiag.messagesPerSecond ?? 0} msg/s)</em>
                        </strong>
                      </div>
                      <div className="dbot-kpi-card">
                        <span>{zh ? "活跃 Topic 数" : "Active Topics"}</span>
                        <strong>{mqttDiag.uniqueTopicCount ?? 0}</strong>
                      </div>
                    </div>
                  )}

                  {mqttDiag.topicsSummary && mqttDiag.topicsSummary.length > 0 && (
                    <div className="dbot-topic-samples">
                      {mqttDiag.topicsSummary.map((item) => (
                        <details key={item.topic} className="dbot-disclosure-row">
                          <summary>
                            <code className="dbot-topic-code">{item.topic}</code>
                            <span className="dbot-topic-meta">
                              {item.payloadType} · {item.messageCount} msg
                              {item.cycleCounter !== undefined
                                ? ` · cycle=${String(item.cycleCounter)}`
                                : ""}
                              {item.durationsMs
                                ? ` · t1–t4: ${item.durationsMs.extendReactionMs}/${item.durationsMs.extendTravelMs}/${item.durationsMs.retractReactionMs}/${item.durationsMs.retractTravelMs} ms`
                                : ""}
                            </span>
                          </summary>
                          <pre>{JSON.stringify(item.latestSample, null, 2)}</pre>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Tool 3: MQTT Broker Backlog & Backpressure Diagnostics */}
          {activeDiagTab === "backlog" && (
            <section className="dbot-panel">
              <div className="dbot-panel-head">
                <div className="dbot-panel-title-block">
                  <h2>
                    {zh ? "MQTT Broker 消息堆积与背压诊断" : "MQTT Broker Backlog & Backpressure"}
                  </h2>
                  <p>
                    {zh
                      ? "采集 Broker $SYS 队列、丢包与离线会话，结合 Connector 发送背压与 QoS 1 环回延迟综合判定。"
                      : "Analyze Broker $SYS queues, drops, offline sessions, publisher backpressure, and QoS 1 loopback latency."}
                  </p>
                </div>
                <button
                  type="button"
                  className="dbot-btn-primary"
                  disabled={backlogLoading}
                  onClick={() => void runBrokerBacklogCheck()}
                >
                  <Icon name={backlogLoading ? "spinner" : "play"} size={14} />
                  {backlogLoading
                    ? zh
                      ? `诊断中 (${backlogDuration}s)…`
                      : `Checking (${backlogDuration}s)…`
                    : zh
                      ? "检测堆积"
                      : "Check Backlog"}
                </button>
              </div>

              <div className="dbot-toolbar">
                <label className="dbot-field-inline is-sm">
                  <span>{zh ? "$SYS 采集时长" : "$SYS Sample"}</span>
                  <select
                    value={backlogDuration}
                    onChange={(e) => setBacklogDuration(Number(e.target.value))}
                  >
                    <option value={2}>2s</option>
                    <option value={3}>3s</option>
                    <option value={5}>5s</option>
                  </select>
                </label>
                <label className="dbot-checkbox-inline">
                  <input
                    type="checkbox"
                    checked={backlogLoopback}
                    onChange={(e) => setBacklogLoopback(e.target.checked)}
                  />
                  <span>
                    {zh
                      ? "启用临时 QoS 1 环回探针（测 PUBACK 与往返延迟，不保留消息）"
                      : "Include non-retained QoS 1 loopback probe (PUBACK & RTT latency)"}
                  </span>
                </label>
              </div>

              {!backlogDiag ? (
                <div className="dbot-panel-empty">
                  <Icon name="layers" size={20} />
                  <span>
                    {zh
                      ? "点击「检测堆积」诊断 Broker 排队情况与 Connector 推送延迟。"
                      : "Click Check Backlog to inspect broker queues and publisher latency."}
                  </span>
                </div>
              ) : (
                <div className="dbot-diag-body">
                  <div
                    className={`dbot-diagnosis-banner ${
                      backlogDiag.status === "HEALTHY"
                        ? "is-ok"
                        : backlogDiag.status === "WARNING"
                          ? "is-warn"
                          : "is-error"
                    }`}
                  >
                    <strong>{backlogDiag.diagnosis || backlogDiag.error}</strong>
                  </div>

                  <div className="dbot-kpi-grid cols-3">
                    <div className="dbot-kpi-card">
                      <span>{zh ? "堆积判定" : "Verdict"}</span>
                      <div>
                        <span
                          className={`dbot-pill ${
                            backlogDiag.status === "HEALTHY"
                              ? "is-ok"
                              : backlogDiag.status === "WARNING"
                                ? "is-warn"
                                : "is-error"
                          }`}
                        >
                          {backlogDiag.status === "HEALTHY"
                            ? zh
                              ? "正常（无堆积）"
                              : "HEALTHY"
                            : backlogDiag.status === "WARNING"
                              ? zh
                                ? "存在风险 / 受限"
                                : "WARNING"
                              : backlogDiag.status === "BACKLOG_DETECTED"
                                ? zh
                                  ? "检测到堆积"
                                  : "BACKLOG DETECTED"
                                : zh
                                  ? "无法连接"
                                  : "UNREACHABLE"}
                        </span>
                      </div>
                      {backlogDiag.brokerVersion && <small>{backlogDiag.brokerVersion}</small>}
                    </div>

                    <div className="dbot-kpi-card">
                      <span>{zh ? "Broker 排队 / 丢弃" : "Queued / Dropped"}</span>
                      <strong>
                        {backlogDiag.sysMetrics?.available
                          ? `${backlogDiag.sysMetrics.estimatedQueuedMessages ?? "—"} / ${backlogDiag.sysMetrics.droppedMessages ?? 0}`
                          : zh
                            ? "$SYS 不可用"
                            : "$SYS N/A"}
                      </strong>
                      {backlogDiag.sysMetrics?.available && (
                        <small>
                          {zh ? "存储" : "Stored"}: {backlogDiag.sysMetrics.storedMessages ?? "—"} ·{" "}
                          {zh ? "保留" : "Retained"}: {backlogDiag.sysMetrics.retainedMessages ?? 0}
                        </small>
                      )}
                    </div>

                    <div className="dbot-kpi-card">
                      <span>{zh ? "离线会话 / 在线客户端" : "Offline / Connected"}</span>
                      <strong>
                        {backlogDiag.sysMetrics?.available
                          ? `${backlogDiag.sysMetrics.disconnectedClients ?? "—"} / ${backlogDiag.sysMetrics.connectedClients ?? "—"}`
                          : "—"}
                      </strong>
                      {backlogDiag.sysMetrics?.available &&
                        backlogDiag.sysMetrics.subscriptionsCount !== null && (
                          <small>
                            {zh ? "订阅数" : "Subs"}: {backlogDiag.sysMetrics.subscriptionsCount}
                          </small>
                        )}
                    </div>

                    <div className="dbot-kpi-card">
                      <span>{zh ? "1 分钟入站 / 出站速率" : "1m In / Out Rate"}</span>
                      <strong>
                        {backlogDiag.sysMetrics?.available
                          ? `${backlogDiag.sysMetrics.publishReceivedRate1m ?? backlogDiag.sysMetrics.receivedRate1m ?? "—"} / ${backlogDiag.sysMetrics.publishSentRate1m ?? backlogDiag.sysMetrics.sentRate1m ?? "—"}`
                          : "—"}
                      </strong>
                    </div>

                    {backlogDiag.publisherBackpressure && (
                      <div className="dbot-kpi-card">
                        <span>{zh ? "Connector 发送背压" : "Publisher Backpressure"}</span>
                        <strong>
                          {zh ? "在途" : "In-flight"} {backlogDiag.publisherBackpressure.inFlightCount}
                          {" · "}
                          {zh ? "超时" : "Timeouts"} {backlogDiag.publisherBackpressure.totalTimeouts}
                        </strong>
                        <small>
                          PUBACK:{" "}
                          {backlogDiag.publisherBackpressure.avgPublishLatencyMs !== null
                            ? `${backlogDiag.publisherBackpressure.avgPublishLatencyMs} ms`
                            : "—"}{" "}
                          · {backlogDiag.publisherBackpressure.recentPublishRatePerSec} msg/s
                        </small>
                      </div>
                    )}

                    {backlogDiag.loopbackProbe?.enabled && (
                      <div className="dbot-kpi-card">
                        <span>{zh ? "Broker 环回延迟" : "Loopback Latency"}</span>
                        <strong>
                          {backlogDiag.loopbackProbe.ok
                            ? `RTT ${backlogDiag.loopbackProbe.roundTripLatencyMs} ms`
                            : zh
                              ? "未完成"
                              : "Failed"}
                        </strong>
                        <small>
                          {backlogDiag.loopbackProbe.ok
                            ? `PUBACK: ${backlogDiag.loopbackProbe.pubackLatencyMs ?? "—"} ms`
                            : backlogDiag.loopbackProbe.error || "—"}
                        </small>
                      </div>
                    )}
                  </div>

                  {backlogDiag.findings && backlogDiag.findings.length > 0 && (
                    <div
                      className={
                        backlogDiag.status === "BACKLOG_DETECTED" ||
                        backlogDiag.status === "UNREACHABLE"
                          ? "dbot-error-box"
                          : "dbot-warning-box"
                      }
                    >
                      <div className="dbot-callout-title">{zh ? "诊断发现" : "Findings"}</div>
                      <ul className="dbot-callout-list">
                        {backlogDiag.findings.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {backlogDiag.recommendations && backlogDiag.recommendations.length > 0 && (
                    <div className="dbot-info-box">
                      <div className="dbot-callout-title">{zh ? "排查建议" : "Recommendations"}</div>
                      <ul className="dbot-callout-list">
                        {backlogDiag.recommendations.map((rec, idx) => (
                          <li key={idx}>{rec}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {backlogDiag.sysMetrics?.available &&
                    Object.keys(backlogDiag.sysMetrics.rawSample).length > 0 && (
                      <details className="dbot-disclosure-row">
                        <summary>
                          <strong>
                            {zh
                              ? `Broker $SYS 原始指标 (${backlogDiag.sysMetrics.topicCount} 项)`
                              : `Broker $SYS Raw Metrics (${backlogDiag.sysMetrics.topicCount} topics)`}
                          </strong>
                        </summary>
                        <pre>{JSON.stringify(backlogDiag.sysMetrics.rawSample, null, 2)}</pre>
                      </details>
                    )}
                </div>
              )}
            </section>
          )}

          {/* Tool 4: Configuration Audit & Backend Runtime Health */}
          {activeDiagTab === "audit" && (
            <section className="dbot-panel">
              <div className="dbot-panel-head">
                <div className="dbot-panel-title-block">
                  <h2>{zh ? "配置静态体检与后端运行状态" : "Configuration Audit & Runtime Health"}</h2>
                  <p>
                    {zh
                      ? "核查 PLC/MQTT 配置边界、PostgreSQL 状态、活跃轮询器及近期后端事件。"
                      : "Validate PLC/MQTT configs and inspect PostgreSQL health, active pollers, and recent events."}
                  </p>
                </div>
                <button
                  type="button"
                  className="dbot-btn-primary"
                  disabled={auditLoading}
                  onClick={() => void runAuditAndHealth()}
                >
                  <Icon name={auditLoading ? "spinner" : "play"} size={14} />
                  {auditLoading
                    ? zh
                      ? "体检中…"
                      : "Auditing…"
                    : zh
                      ? "执行体检"
                      : "Run Audit"}
                </button>
              </div>

              {!auditDiag && !healthDiag ? (
                <div className="dbot-panel-empty">
                  <Icon name="shield" size={20} />
                  <span>
                    {zh
                      ? "点击「执行体检」检查当前配置健康度与后端运行日志。"
                      : "Click Run Audit to check saved configuration and backend health."}
                  </span>
                </div>
              ) : (
                <div className="dbot-diag-body">
                  {healthDiag && (
                    <div className="dbot-kpi-grid cols-3">
                      <div className="dbot-kpi-card">
                        <span>PostgreSQL</span>
                        <div>
                          <span className={`dbot-pill ${healthDiag.database.ok ? "is-ok" : "is-error"}`}>
                            {healthDiag.database.ok
                              ? `OK · ${healthDiag.database.latencyMs} ms`
                              : "ERROR"}
                          </span>
                        </div>
                        <small>
                          {zh
                            ? `已保存配置 ${healthDiag.database.savedConfigurations} 条`
                            : `${healthDiag.database.savedConfigurations} saved configs`}
                        </small>
                      </div>
                      <div className="dbot-kpi-card">
                        <span>{zh ? "活跃轮询器" : "Active Pollers"}</span>
                        <strong>
                          Modbus {healthDiag.activePollers.modbusCount} · OPC UA{" "}
                          {healthDiag.activePollers.opcuaCount}
                        </strong>
                      </div>
                      <div className="dbot-kpi-card">
                        <span>{zh ? "运行时间 / 内存" : "Uptime / Memory"}</span>
                        <strong>
                          {formatUptime(healthDiag.uptimeSeconds, zh)} · {healthDiag.memoryMb.rss} MB
                        </strong>
                        <small>Node {healthDiag.nodeVersion}</small>
                      </div>
                    </div>
                  )}

                  {auditDiag && auditDiag.errors.length > 0 && (
                    <div className="dbot-error-box">
                      <div className="dbot-callout-title">{zh ? "配置错误" : "Errors"}</div>
                      <ul className="dbot-callout-list">
                        {auditDiag.errors.map((err, idx) => (
                          <li key={idx}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {auditDiag && auditDiag.warnings.length > 0 && (
                    <div className="dbot-warning-box">
                      <div className="dbot-callout-title">{zh ? "注意事项" : "Warnings"}</div>
                      <ul className="dbot-callout-list">
                        {auditDiag.warnings.map((warn, idx) => (
                          <li key={idx}>{warn}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {auditDiag && auditDiag.checks.length > 0 && (
                    <div className="dbot-table-wrap">
                      <table className="dbot-table">
                        <thead>
                          <tr>
                            <th>{zh ? "检查项" : "Target"}</th>
                            <th>{zh ? "结果" : "Status"}</th>
                            <th>{zh ? "详情" : "Details"}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {auditDiag.checks.map((c, idx) => (
                            <tr key={idx}>
                              <td>
                                <strong>{c.target}</strong>
                              </td>
                              <td>
                                <span className="dbot-pill is-ok">{c.status}</span>
                              </td>
                              <td>{c.detail}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {healthDiag && healthDiag.recentEvents.length > 0 && (
                    <div className="dbot-events-section">
                      <div className="dbot-subhead">
                        <span>
                          {zh
                            ? `近期后端事件 (${healthDiag.recentEvents.length})`
                            : `Recent Backend Events (${healthDiag.recentEvents.length})`}
                        </span>
                      </div>
                      <div className="dbot-table-wrap dbot-table-scroll">
                        <table className="dbot-table">
                          <thead>
                            <tr>
                              <th>{zh ? "时间" : "Time"}</th>
                              <th>{zh ? "级别" : "Level"}</th>
                              <th>{zh ? "模块" : "Component"}</th>
                              <th>{zh ? "详情" : "Message"}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {healthDiag.recentEvents.map((ev, idx) => {
                              const lv = ev.level.toUpperCase();
                              const pillTone =
                                lv === "ERROR"
                                  ? "is-error"
                                  : lv === "WARN" || lv === "WARNING"
                                    ? "is-warn"
                                    : "is-neutral";
                              return (
                                <tr key={`${ev.timestamp}-${idx}`}>
                                  <td className="dbot-num dbot-muted-cell">
                                    {formatLocalTime(ev.timestamp)}
                                  </td>
                                  <td>
                                    <span className={`dbot-pill ${pillTone}`}>{lv}</span>
                                  </td>
                                  <td>
                                    <code className="dbot-topic-code">
                                      {ev.component}
                                      {ev.plcId ? `/${ev.plcId}` : ""}
                                    </code>
                                  </td>
                                  <td>{ev.message}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <details className="dbot-disclosure-row">
                        <summary>
                          <span className="dbot-muted-summary">
                            {zh ? "查看原始事件 JSON" : "View Raw Events JSON"}
                          </span>
                        </summary>
                        <pre>{JSON.stringify(healthDiag.recentEvents, null, 2)}</pre>
                      </details>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* VIEW 3: MODEL & SKILLS SETTINGS */}
      {activeView === "settings" && (
        <div className="dbot-settings-grid">
          <form className="dbot-panel" onSubmit={handleSaveSettings}>
            <div className="dbot-panel-head">
              <div className="dbot-panel-title-block">
                <h2>{zh ? "模型与 API Key 配置" : "Model & API Key"}</h2>
                <p>
                  {zh
                    ? "配置持久化保存在 PostgreSQL，保存后立即生效。"
                    : "Persisted in PostgreSQL and applied immediately."}
                </p>
              </div>
            </div>

            <div className="dbot-setting-section">
              <div className="dbot-section-label">{zh ? "服务商预设" : "Provider Preset"}</div>
              <div className="dbot-preset-pills">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`dbot-preset-pill ${provider === preset.id ? "is-selected" : ""}`}
                    onClick={() => selectPreset(preset)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="dbot-form-grid">
              <label className="dbot-field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.deepseek.com"
                  required
                />
              </label>

              <label className="dbot-field">
                <span>{zh ? "模型名称 (Model)" : "Model Name"}</span>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="deepseek-chat / gpt-4o / qwen2.5:14b"
                  required
                />
              </label>
            </div>

            <label className="dbot-field dbot-field-full">
              <span className="dbot-field-label-row">
                <span>API Key</span>
                {config?.hasApiKey && (
                  <em className="dbot-saved-key-tag">
                    {zh ? "已保存" : "Saved"}: {config.apiKeyMasked}
                  </em>
                )}
              </span>
              <div className="dbot-key-row">
                <input
                  type="password"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder={
                    config?.hasApiKey
                      ? zh
                        ? "留空保持现有 Key，或输入新 Key 覆盖"
                        : "Leave blank to keep saved key, or enter new key"
                      : "sk-..."
                  }
                  autoComplete="off"
                />
                {config?.hasApiKey && (
                  <button
                    type="button"
                    className="dbot-btn-secondary"
                    onClick={() => void handleClearApiKey()}
                    disabled={savingSettings}
                  >
                    {zh ? "清除" : "Clear"}
                  </button>
                )}
              </div>
            </label>

            <details className="dbot-advanced-box">
              <summary>
                <span>{zh ? "高级参数与系统提示词" : "Advanced Options & System Prompt"}</span>
                <span className="dbot-advanced-meta">
                  {apiFormat === "openai" ? "OpenAI" : "Anthropic"} · T={temperature} ·{" "}
                  {maxToolSteps} {zh ? "步" : "steps"}
                </span>
              </summary>
              <div className="dbot-advanced-body">
                <div className="dbot-form-grid-3">
                  <label className="dbot-field">
                    <span>{zh ? "接口协议" : "API Format"}</span>
                    <select
                      value={apiFormat}
                      onChange={(e) => setApiFormat(e.target.value as "openai" | "anthropic")}
                    >
                      <option value="openai">OpenAI (/chat/completions)</option>
                      <option value="anthropic">Anthropic (/messages)</option>
                    </select>
                  </label>

                  <label className="dbot-field">
                    <span>Temperature</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={temperature}
                      onChange={(e) => setTemperature(e.target.value)}
                    />
                  </label>

                  <label className="dbot-field">
                    <span>{zh ? "最大工具轮数" : "Max Tool Steps"}</span>
                    <input
                      type="number"
                      min="1"
                      max="16"
                      value={maxToolSteps}
                      onChange={(e) => setMaxToolSteps(e.target.value)}
                    />
                  </label>
                </div>

                <label className="dbot-field">
                  <span>
                    {zh
                      ? "附加系统提示词（可选）"
                      : "Additional System Instructions (Optional)"}
                  </span>
                  <textarea
                    rows={3}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder={
                      zh
                        ? "例如：重点关注 1 号产线超过 5 分钟未更新的气缸，报告中附带对应 MQTT Topic…"
                        : "Optional site-specific diagnostic rules for Debug Bot…"
                    }
                  />
                </label>
              </div>
            </details>

            {settingsNotice && (
              <div className={`dbot-settings-notice is-${settingsNotice.type}`}>
                <Icon name={settingsNotice.type === "ok" ? "check" : "shield"} size={15} />
                <span>{settingsNotice.text}</span>
              </div>
            )}

            <div className="dbot-form-actions">
              <button
                type="button"
                className="dbot-btn-secondary"
                disabled={testingSettings || savingSettings}
                onClick={() => void handleTestConnection()}
              >
                <Icon name={testingSettings ? "spinner" : "activity"} size={14} />
                {zh ? "测试连接" : "Test Connection"}
              </button>
              <button type="submit" className="dbot-btn-primary" disabled={savingSettings}>
                <Icon name={savingSettings ? "spinner" : "check"} size={14} />
                {zh ? "保存配置" : "Save Settings"}
              </button>
            </div>
          </form>

          {/* Registered Debug Bot Skills Inventory */}
          <aside className="dbot-panel dbot-skills-panel">
            <div className="dbot-panel-head dbot-skills-head">
              <div className="dbot-panel-title-inline">
                <Icon name="wrench" size={16} />
                <h2>{zh ? "已挂载诊断技能" : "Registered Skills"}</h2>
              </div>
              <span className="dbot-count-badge">{tools.length}</span>
            </div>

            <div className="dbot-skills-list">
              {tools.map((tool) => (
                <div key={tool.name} className="dbot-skill-item">
                  <div className="dbot-skill-top">
                    <code>{tool.name}</code>
                    <span className="dbot-cat-tag">{tool.category}</span>
                  </div>
                  <p>
                    {zh
                      ? tool.summaryZh || tool.description
                      : tool.summaryEn || tool.description}
                  </p>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
