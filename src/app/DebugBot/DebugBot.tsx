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

interface CylinderFreshnessItem {
  blockIndex: number;
  startAddress: number;
  topic: string;
  partNumber: string | null;
  cycleCounter: unknown;
  firstSeenAt: string | null;
  lastDataUpdatedAt: string | null;
  hasUpdatedSinceStart: boolean;
  updateCount: number;
  staleDurationMs: number | null;
  staleDurationSeconds: number | null;
  isStale: boolean;
  freshnessStatus: "FRESH" | "STALE" | "NEVER_UPDATED" | "NO_DATA";
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
    lastPollAt?: string | null;
    checkedAt?: string;
    summary: {
      totalCylinders: number;
      staleThresholdSeconds: number;
      freshCount: number;
      staleCount: number;
      neverUpdatedCount: number;
      maxStaleDurationMs: number | null;
      maxStaleDurationSeconds: number | null;
    };
    cylinders: CylinderFreshnessItem[];
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

function Icon({ name, size = 16, className = "" }: { name: string; size?: number; className?: string }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
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
    case "chat":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
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
    case "cpu":
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <line x1="9" y1="1" x2="9" y2="4" />
          <line x1="15" y1="1" x2="15" y2="4" />
          <line x1="9" y1="20" x2="9" y2="23" />
          <line x1="15" y1="20" x2="15" y2="23" />
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

function ToolTraceCard({ trace, zh }: { trace: ToolCallTrace; zh: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="dbot-trace-item">
      <button
        type="button"
        className="dbot-trace-header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span>{expanded ? "▾" : "▸"}</span>
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
  const [staleThresholdSeconds, setStaleThresholdSeconds] = useState(60);
  const [datablocksFilter, setDatablocksFilter] = useState<"all" | "stale">("all");
  const [datablocksSort, setDatablocksSort] = useState<"stale" | "index">("stale");
  const [datablocksDiag, setDatablocksDiag] = useState<DatablocksInspectResult | null>(null);
  const [datablocksLoading, setDatablocksLoading] = useState(false);
  const [mqttTopicInput, setMqttTopicInput] = useState("");
  const [mqttDuration, setMqttDuration] = useState(3);
  const [mqttDiag, setMqttDiag] = useState<MqttSubscribeResult | null>(null);
  const [mqttLoading, setMqttLoading] = useState(false);

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

  useEffect(() => {
    void loadInitialState();
  }, [loadInitialState]);

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
          ? "配置已保存到 PostgreSQL 数据库并立即生效。"
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
          ? `模型连接成功：${data.model}（耗时 ${data.latencyMs} ms）`
          : `Model connected: ${data.model} (${data.latencyMs} ms)`,
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
          label: "检测所有气缸多久没有更新数据",
          prompt:
            "请检查所有运行中的 Modbus 气缸 Datablock，列出每个气缸多久没有更新数据，重点标出长时间未更新或从未更新的气缸。",
        },
        {
          label: "全面体检配置与 MQTT 推流采样",
          prompt:
            "请体检当前 Connector 的 PLC 配置，并订阅已配置的 MQTT Topic 采样 3 秒，核查气缸 6 个时间戳与 4 个特征时间是否全部正常。",
        },
        {
          label: "测试 PLC 与 MQTT 协议层连通性",
          prompt:
            "请对已保存的 PLC 和 MQTT Broker 执行实时 TCP 与协议层握手测试，分解连接与读取延迟并定位任何网络或认证异常。",
        },
        {
          label: "配置体检与后端错误日志排查",
          prompt:
            "请执行配置体检（检查地址越界、FC03 分批耗时与轮询周期匹配度、重复 Topic）并查看 PostgreSQL、内存和近期后端报错事件。",
        },
      ]
    : [
        {
          label: "Check Cylinder Data Update Freshness",
          prompt:
            "Inspect all active Modbus cylinder datablocks and report how long each cylinder has gone without updating data, highlighting any stale or never-updated cylinders.",
        },
        {
          label: "Audit Config & Sample Live MQTT Stream",
          prompt:
            "Validate saved Connector PLC & MQTT configurations and subscribe to configured MQTT topics for 3 seconds to verify 6-timestamp cylinder cycles and t1..t4 durations.",
        },
        {
          label: "Test PLC & MQTT Protocol Connectivity",
          prompt:
            "Run live TCP and protocol-level handshakes against all saved PLCs and the MQTT broker, reporting latencies and any network, protocol, or authentication errors.",
        },
        {
          label: "Audit Configuration & Runtime Health",
          prompt:
            "Validate the saved Connector configuration (register bounds, FC03 batch timing, duplicate topics) and inspect PostgreSQL health, uptime, and recent backend diagnostic errors.",
        },
      ];

  return (
    <div className="unified-module-container dbot-scope">
      <div className="unified-module-header">
        <div className="unified-module-title-group">
          <h1>
            Debug Bot
            <span>{config ? `${config.provider} · ${config.model}` : "Connector Diagnostics"}</span>
          </h1>
        </div>
        <div className="unified-module-controls">
          <span className={`unified-status-pill ${config?.configured ? "is-connected" : ""}`}>
            <i />
            {config?.configured
              ? zh
                ? "模型已就绪"
                : "Model Ready"
              : zh
                ? "未配置 API Key"
                : "API Key Needed"}
          </span>
          <button
            type="button"
            className="dbot-btn-secondary"
            onClick={() => setActiveView(activeView === "settings" ? "chat" : "settings")}
          >
            <Icon name="settings" size={15} />
            {activeView === "settings"
              ? zh
                ? "返回对话"
                : "Back to Chat"
              : zh
                ? "模型与 Key 设置"
                : "Model Settings"}
          </button>
        </div>
      </div>

          {loadError && (
        <div className="dbot-error-box" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span>{loadError}</span>
          <button
            type="button"
            className="dbot-btn-secondary"
            onClick={() => void loadInitialState()}
          >
            {zh ? "重新加载" : "Retry"}
          </button>
        </div>
      )}

      {/* VIEW 1: AI CHAT */}
          {activeView === "chat" && (
            <div className="dbot-chat-layout">
              {config && !config.configured && (
                <div className="dbot-setup-banner">
                  <div className="dbot-setup-banner-text">
                    <Icon name="shield" size={18} />
                    <div>
                      <strong>
                        {zh ? "尚未配置大模型 API Key" : "No LLM API Key configured yet"}
                      </strong>
                      <p>
                        {zh
                          ? "可在「模型与技能设置」配置 DeepSeek / OpenAI / 通义千问 / 本地 Ollama；也可以直接切到「实时巡检工作台」免 Key 运行全部 Connector 诊断技能。"
                          : "Configure DeepSeek / OpenAI / Qwen / local Ollama in Model & Skills, or switch to Quick Diagnostics to run all Connector diagnostic skills without an API key."}
                      </p>
                    </div>
                  </div>
                  <div className="dbot-setup-banner-actions">
                    <button
                      type="button"
                      className="dbot-btn-secondary"
                      onClick={() => setActiveView("diagnostics")}
                    >
                      <Icon name="activity" size={14} />
                      {zh ? "实时巡检" : "Quick Diagnostics"}
                    </button>
                    <button
                      type="button"
                      className="dbot-btn-primary"
                      onClick={() => setActiveView("settings")}
                    >
                      <Icon name="settings" size={14} />
                      {zh ? "配置模型" : "Configure Model"}
                    </button>
                  </div>
                </div>
              )}

              <div className="dbot-chat-card">
                <div className="dbot-chat-topbar">
                  <div className="dbot-chat-meta">
                    <Icon name="bot" size={17} />
                    <span>
                      {zh
                        ? `已挂载 ${tools.length || 6} 个 Connector 专属诊断技能（气缸更新时长监测 / MQTT 采样 / 连通性测试 / 配置体检 / 系统日志）`
                        : `${tools.length || 6} Connector diagnostic skills attached (Cylinder Freshness / MQTT Sampler / Connectivity / Config Audit / Runtime Health)`}
                    </span>
                  </div>
                  {messages.length > 0 && (
                    <button
                      type="button"
                      className="dbot-icon-text-btn"
                      onClick={() => setMessages([])}
                      disabled={sending}
                    >
                      <Icon name="trash" size={14} />
                      {zh ? "清空对话" : "Clear"}
                    </button>
                  )}
                </div>

                <div className="dbot-chat-messages">
                  {messages.length === 0 ? (
                    <div className="dbot-empty-state">
                      <div className="dbot-empty-badge">
                        <Icon name="sparkle" size={24} />
                      </div>
                      <h3>
                        {zh
                          ? "Debug Bot · Connector 智能排障助手"
                          : "Debug Bot · Connector Diagnostics Assistant"}
                      </h3>
                      <p>
                        {zh
                          ? "直接描述现场问题或点击下方快捷诊断，Debug Bot 会自动调用实时工具监测所有气缸数据更新时长、体检配置、测试连通性并采样 MQTT 数据流。"
                          : "Describe any PLC/MQTT issue or pick a preset below. Debug Bot automatically monitors cylinder update freshness, audits configuration, tests connectivity, and samples live MQTT streams."}
                      </p>
                      <div className="dbot-quick-prompts">
                        {quickPrompts.map((item) => (
                          <button
                            key={item.label}
                            type="button"
                            className="dbot-prompt-chip"
                            disabled={sending}
                            onClick={() => void sendMessage(item.prompt)}
                          >
                            <Icon name="sparkle" size={14} />
                            <span>{item.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    messages.map((msg) => (
                      <div key={msg.id} className={`dbot-msg-row is-${msg.role}`}>
                        <div className={`dbot-msg-bubble ${msg.error ? "is-error" : ""}`}>
                          {msg.role === "assistant" && (
                            <div className="dbot-msg-role-head">
                              <span className="dbot-msg-role-tag">
                                <Icon name="bot" size={13} /> Debug Bot
                              </span>
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
                    ))
                  )}

                  {sending && (
                    <div className="dbot-msg-row is-assistant">
                      <div className="dbot-msg-bubble is-thinking">
                        <Icon name="spinner" size={16} />
                        <span>
                          {zh
                            ? "Debug Bot 正在调用诊断技能分析实时数据…"
                            : "Debug Bot is invoking diagnostic skills on live data…"}
                        </span>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <form
                  className="dbot-composer"
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
                        ? "例如：帮我检查哪些气缸长时间没有更新数据，或者为什么 5 号气缸没有发 MQTT…"
                        : "Ask Debug Bot which cylinders haven't updated data recently, test connectivity, or sample MQTT…"
                    }
                    disabled={sending}
                  />
                  <button
                    type="submit"
                    className="dbot-send-btn"
                    disabled={sending || !input.trim()}
                  >
                    <Icon name={sending ? "spinner" : "send"} size={16} />
                    <span>{zh ? "发送" : "Send"}</span>
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* VIEW 2: QUICK DIAGNOSTICS WORKBENCH (NO LLM KEY NEEDED) */}
          {activeView === "diagnostics" && (
            <div className="dbot-diag-grid">
              {/* Panel 1: Modbus Cylinder Data Freshness Monitor */}
              <section className="dbot-panel">
                <div className="dbot-panel-head">
                  <div className="dbot-panel-title">
                    <Icon name="activity" size={18} />
                    <h2>
                      {zh
                        ? "1. Modbus 气缸数据更新时长监测"
                        : "1. Modbus Cylinder Data Freshness Monitor"}
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="dbot-btn-primary"
                    disabled={datablocksLoading}
                    onClick={() => void runDatablocksInspect()}
                  >
                    <Icon name={datablocksLoading ? "spinner" : "activity"} size={15} />
                    {zh ? "检测未更新时长" : "Check Freshness"}
                  </button>
                </div>

                <div className="dbot-inline-controls">
                  <label className="dbot-field-inline is-compact">
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
                  <label className="dbot-field-inline is-compact">
                    <span>{zh ? "筛选显示" : "Filter"}</span>
                    <select
                      value={datablocksFilter}
                      onChange={(e) => setDatablocksFilter(e.target.value as "all" | "stale")}
                    >
                      <option value="all">{zh ? "全部气缸" : "All Cylinders"}</option>
                      <option value="stale">{zh ? "仅看超时未更新" : "Stale Only"}</option>
                    </select>
                  </label>
                  <label className="dbot-field-inline is-compact">
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

                {datablocksDiag && (
                  <div className="dbot-diag-body">
                    {!datablocksDiag.found ? (
                      <div className="dbot-warning-box">{datablocksDiag.message}</div>
                    ) : (
                      datablocksDiag.pollers.map((p) => {
                        const visibleCylinders = (
                          datablocksFilter === "stale"
                            ? p.cylinders.filter((c) => c.isStale)
                            : [...p.cylinders]
                        ).sort((a, b) => {
                          if (datablocksSort === "index") return a.blockIndex - b.blockIndex;
                          const diff = (b.staleDurationMs ?? -1) - (a.staleDurationMs ?? -1);
                          return diff !== 0 ? diff : a.blockIndex - b.blockIndex;
                        });

                        return (
                          <div key={`${p.namespace}-${p.plcId}`} className="dbot-diag-body">
                            <div className="dbot-stat-strip">
                              <div className="dbot-stat-box">
                                <span>PLC ({p.endian})</span>
                                <strong>
                                  {p.plcId} · {p.endpoint}
                                </strong>
                                <small>
                                  {p.pollingStatus} · {p.pollingMs}ms
                                </small>
                              </div>
                              <div className="dbot-stat-box">
                                <span>{zh ? "气缸总数" : "Total Cylinders"}</span>
                                <strong>{p.summary.totalCylinders}</strong>
                              </div>
                              <div className="dbot-stat-box">
                                <span>
                                  {zh
                                    ? `超时未更新 (≥${p.summary.staleThresholdSeconds}s)`
                                    : `Stale (≥${p.summary.staleThresholdSeconds}s)`}
                                </span>
                                <strong
                                  className={`dbot-pill ${p.summary.staleCount > 0 ? "is-error" : "is-ok"}`}
                                >
                                  {p.summary.staleCount} / {p.summary.totalCylinders}
                                </strong>
                              </div>
                              <div className="dbot-stat-box">
                                <span>{zh ? "自监听起未更新" : "Never Updated"}</span>
                                <strong>{p.summary.neverUpdatedCount}</strong>
                              </div>
                              <div className="dbot-stat-box">
                                <span>{zh ? "最长未更新时长" : "Longest Stale"}</span>
                                <strong>{formatStaleDuration(p.summary.maxStaleDurationMs, zh)}</strong>
                              </div>
                            </div>

                            {p.summary.totalCylinders === 0 ? (
                              <div className="dbot-warning-box">
                                {zh
                                  ? `PLC「${p.plcId}」当前没有 Datablock 气缸数据（可能为寄存器单读模式或尚未完成首次读取）。`
                                  : `PLC "${p.plcId}" currently has 0 datablock cylinders (may be in register mode or awaiting first read).`}
                              </div>
                            ) : visibleCylinders.length === 0 ? (
                              <div className="dbot-diagnosis-banner is-ok">
                                <strong>
                                  {zh
                                    ? `全部 ${p.summary.totalCylinders} 个气缸均在 ${p.summary.staleThresholdSeconds} 秒内有更新，无超时气缸。`
                                    : `All ${p.summary.totalCylinders} cylinders updated within ${p.summary.staleThresholdSeconds}s.`}
                                </strong>
                              </div>
                            ) : (
                              <div className="dbot-table-wrap dbot-table-scroll">
                                <table className="dbot-table">
                                  <thead>
                                    <tr>
                                      <th>DB #</th>
                                      <th>Topic / Part</th>
                                      <th>{zh ? "状态" : "Status"}</th>
                                      <th>{zh ? "多久未更新" : "Time Since Update"}</th>
                                      <th>{zh ? "最后更新时间" : "Last Updated"}</th>
                                      <th>{zh ? "更新次数" : "Updates"}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {visibleCylinders.map((c) => {
                                      const pillClass =
                                        c.freshnessStatus === "FRESH"
                                          ? "is-ok"
                                          : c.freshnessStatus === "STALE"
                                            ? "is-error"
                                            : "is-warn";
                                      const statusText =
                                        c.freshnessStatus === "FRESH"
                                          ? zh
                                            ? "正常更新"
                                            : "Fresh"
                                          : c.freshnessStatus === "STALE"
                                            ? c.hasUpdatedSinceStart
                                              ? zh
                                                ? "超时未更新"
                                                : "Stale"
                                              : zh
                                                ? "超时（从未更新）"
                                                : "Stale (Never)"
                                            : c.freshnessStatus === "NEVER_UPDATED"
                                              ? zh
                                                ? "自监听起未更新"
                                                : "Never Updated"
                                              : zh
                                                ? "无数据"
                                                : "No Data";
                                      const durationText = formatStaleDuration(c.staleDurationMs, zh);

                                      return (
                                        <tr key={`${p.namespace}-${p.plcId}-${c.blockIndex}`}>
                                          <td>#{c.blockIndex + 1}</td>
                                          <td>
                                            {c.partNumber && (
                                              <>
                                                <strong>{c.partNumber}</strong>{" "}
                                              </>
                                            )}
                                            <code>{c.topic}</code>
                                          </td>
                                          <td>
                                            <span className={`dbot-pill ${pillClass}`}>
                                              {statusText}
                                            </span>
                                          </td>
                                          <td>
                                            <strong>
                                              {!c.hasUpdatedSinceStart && c.staleDurationMs !== null
                                                ? `≥ ${durationText}`
                                                : durationText}
                                            </strong>
                                          </td>
                                          <td>
                                            {c.lastDataUpdatedAt
                                              ? formatLocalTime(c.lastDataUpdatedAt)
                                              : c.firstSeenAt
                                                ? zh
                                                  ? `—（监听始于 ${formatLocalTime(c.firstSeenAt)}）`
                                                  : `— (since ${formatLocalTime(c.firstSeenAt)})`
                                                : "—"}
                                          </td>
                                          <td>{c.updateCount}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </section>

              {/* Panel 2: Live MQTT Sampler */}
              <section className="dbot-panel">
                <div className="dbot-panel-head">
                  <div className="dbot-panel-title">
                    <Icon name="radio" size={18} />
                    <h2>
                      {zh
                        ? "2. MQTT 实时订阅采样与 4 特征时间校验"
                        : "2. Live MQTT Subscription Sampler & Stroke Validation"}
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="dbot-btn-primary"
                    disabled={mqttLoading}
                    onClick={() => void runMqttSample()}
                  >
                    <Icon name={mqttLoading ? "spinner" : "radio"} size={15} />
                    {mqttLoading
                      ? zh
                        ? `采样中 (${mqttDuration}s)…`
                        : `Sampling (${mqttDuration}s)…`
                      : zh
                        ? "开始订阅采样"
                        : "Subscribe & Sample"}
                  </button>
                </div>

                <div className="dbot-inline-controls">
                  <label className="dbot-field-inline">
                    <span>
                      {zh
                        ? "自定义 Topic（留空自动读取 Connector 配置）"
                        : "Custom Topic Filter (blank = auto from Connector)"}
                    </span>
                    <input
                      type="text"
                      value={mqttTopicInput}
                      onChange={(e) => setMqttTopicInput(e.target.value)}
                      placeholder="festo-ax/pni/#, festo/plc/#"
                    />
                  </label>
                  <label className="dbot-field-inline is-compact">
                    <span>{zh ? "采样时长 (秒)" : "Duration (s)"}</span>
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

                {mqttDiag && (
                  <div className="dbot-diag-body">
                    <div
                      className={`dbot-diagnosis-banner ${mqttDiag.ok && (mqttDiag.totalMessages ?? 0) > 0 ? "is-ok" : "is-warn"}`}
                    >
                      <strong>{mqttDiag.diagnosis || mqttDiag.error}</strong>
                    </div>

                    {mqttDiag.connected && (
                      <div className="dbot-stat-strip">
                        <div className="dbot-stat-box">
                          <span>Broker</span>
                          <strong>{mqttDiag.brokerUrl}</strong>
                          <small>
                            {zh ? "连接耗时" : "Connect"}: {mqttDiag.connectLatencyMs ?? "—"} ms
                          </small>
                        </div>
                        <div className="dbot-stat-box">
                          <span>{zh ? "收到消息数" : "Messages"}</span>
                          <strong>
                            {mqttDiag.totalMessages ?? 0} ({mqttDiag.messagesPerSecond ?? 0} msg/s)
                          </strong>
                        </div>
                        <div className="dbot-stat-box">
                          <span>{zh ? "活跃 Topic 数" : "Active Topics"}</span>
                          <strong>{mqttDiag.uniqueTopicCount ?? 0}</strong>
                        </div>
                      </div>
                    )}

                    {mqttDiag.topicsSummary && mqttDiag.topicsSummary.length > 0 && (
                      <div className="dbot-topic-samples">
                        {mqttDiag.topicsSummary.map((item) => (
                          <details key={item.topic} className="dbot-topic-sample-item">
                            <summary>
                              <code>{item.topic}</code>
                              <span className="dbot-topic-meta">
                                {item.payloadType} · {item.messageCount} msg
                                {item.cycleCounter !== undefined
                                  ? ` · cycle=${String(item.cycleCounter)}`
                                  : ""}
                                {item.durationsMs
                                  ? ` · t1..t4=${item.durationsMs.extendReactionMs}/${item.durationsMs.extendTravelMs}/${item.durationsMs.retractReactionMs}/${item.durationsMs.retractTravelMs}ms`
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

              {/* Panel 3: Configuration Audit & Backend Runtime Health */}
              <section className="dbot-panel">
                <div className="dbot-panel-head">
                  <div className="dbot-panel-title">
                    <Icon name="shield" size={18} />
                    <h2>
                      {zh
                        ? "3. 配置静态体检与后端运行日志"
                        : "3. Configuration Audit & Backend Runtime Health"}
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="dbot-btn-primary"
                    disabled={auditLoading}
                    onClick={() => void runAuditAndHealth()}
                  >
                    <Icon name={auditLoading ? "spinner" : "play"} size={15} />
                    {zh ? "执行体检" : "Run Audit"}
                  </button>
                </div>

                {(auditDiag || healthDiag) && (
                  <div className="dbot-diag-body">
                    {healthDiag && (
                      <div className="dbot-stat-strip">
                        <div className="dbot-stat-box">
                          <span>PostgreSQL</span>
                          <strong className={`dbot-pill ${healthDiag.database.ok ? "is-ok" : "is-error"}`}>
                            {healthDiag.database.ok
                              ? `OK (${healthDiag.database.latencyMs} ms)`
                              : "ERROR"}
                          </strong>
                        </div>
                        <div className="dbot-stat-box">
                          <span>{zh ? "活跃轮询器" : "Active Pollers"}</span>
                          <strong>
                            Modbus: {healthDiag.activePollers.modbusCount} · OPC UA:{" "}
                            {healthDiag.activePollers.opcuaCount}
                          </strong>
                        </div>
                        <div className="dbot-stat-box">
                          <span>{zh ? "运行时间 / 内存" : "Uptime / Memory"}</span>
                          <strong>
                            {healthDiag.uptimeSeconds}s · {healthDiag.memoryMb.rss} MB RSS
                          </strong>
                        </div>
                      </div>
                    )}

                    {auditDiag && auditDiag.errors.length > 0 && (
                      <div className="dbot-error-box">
                        {auditDiag.errors.map((err, idx) => (
                          <div key={idx}>• {err}</div>
                        ))}
                      </div>
                    )}

                    {auditDiag && auditDiag.warnings.length > 0 && (
                      <div className="dbot-warning-box">
                        {auditDiag.warnings.map((warn, idx) => (
                          <div key={idx}>• {warn}</div>
                        ))}
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
                      <details className="dbot-topic-sample-item" open>
                        <summary>
                          <strong>
                            {zh
                              ? `近期后端诊断事件 (${healthDiag.recentEvents.length})`
                              : `Recent Backend Events (${healthDiag.recentEvents.length})`}
                          </strong>
                        </summary>
                        <pre>{JSON.stringify(healthDiag.recentEvents, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* VIEW 3: MULTI-CUSTOMER MODEL & SKILLS SETTINGS */}
          {activeView === "settings" && (
            <div className="dbot-settings-grid">
              <form className="dbot-panel" onSubmit={handleSaveSettings}>
                <div className="dbot-panel-head">
                  <div className="dbot-panel-title">
                    <Icon name="settings" size={18} />
                    <h2>{zh ? "模型与 API Key 配置" : "Model & API Key Configuration"}</h2>
                  </div>
                </div>

                <div className="dbot-preset-grid">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`dbot-preset-card ${provider === preset.id ? "is-selected" : ""}`}
                      onClick={() => selectPreset(preset)}
                    >
                      <strong>{preset.label}</strong>
                    </button>
                  ))}
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

                  <label className="dbot-field">
                    <span>
                      API Key{" "}
                      {config?.hasApiKey && (
                        <em className="dbot-saved-key-tag">
                          ({zh ? "已保存" : "Saved"}: {config.apiKeyMasked})
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

                  <label className="dbot-field">
                    <span>{zh ? "接口协议格式" : "API Format"}</span>
                    <select
                      value={apiFormat}
                      onChange={(e) => setApiFormat(e.target.value as "openai" | "anthropic")}
                    >
                      <option value="openai">OpenAI Compatible (/chat/completions)</option>
                      <option value="anthropic">Anthropic Messages (/messages)</option>
                    </select>
                  </label>

                  <div className="dbot-field-pair">
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
                </div>

                <label className="dbot-field dbot-field-full">
                  <span>
                    {zh
                      ? "附加系统提示词（可选，定制客户现场诊断规则）"
                      : "Additional System Instructions (Optional)"}
                  </span>
                  <textarea
                    rows={3}
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder={
                      zh
                        ? "例如：重点关注 1 号产线超过 5 分钟未更新数据的气缸，报告中附带对应 MQTT Topic…"
                        : "Optional site-specific diagnostic rules for Debug Bot…"
                    }
                  />
                </label>

                {settingsNotice && (
                  <div className={`dbot-settings-notice is-${settingsNotice.type}`}>
                    <Icon name={settingsNotice.type === "ok" ? "check" : "shield"} size={16} />
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
                    <Icon name={testingSettings ? "spinner" : "activity"} size={15} />
                    {zh ? "测试模型连接" : "Test Connection"}
                  </button>
                  <button type="submit" className="dbot-btn-primary" disabled={savingSettings}>
                    <Icon name={savingSettings ? "spinner" : "check"} size={15} />
                    {zh ? "保存到数据库" : "Save Settings"}
                  </button>
                </div>
              </form>

              {/* Registered Debug Bot Skills Inventory */}
              <aside className="dbot-panel">
                <div className="dbot-panel-head">
                  <div className="dbot-panel-title">
                    <Icon name="wrench" size={18} />
                    <h2>
                      {zh
                        ? `已挂载诊断技能 (${tools.length})`
                        : `Registered Debug Skills (${tools.length})`}
                    </h2>
                  </div>
                </div>

                <div className="dbot-tools-list">
                  {tools.map((tool) => (
                    <div key={tool.name} className="dbot-tool-row">
                      <div className="dbot-tool-row-top">
                        <code>{tool.name}</code>
                        <span className={`dbot-cat-tag is-${tool.category}`}>{tool.category}</span>
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
