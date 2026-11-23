import { query as defaultQuery } from "../database.js";

export const DEBUG_BOT_CONFIG_ID = "default";

export const DEBUG_BOT_PROVIDER_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    apiFormat: "openai",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    requiresApiKey: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    apiFormat: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    requiresApiKey: true,
  },
  {
    id: "qwen",
    label: "Qwen (DashScope)",
    apiFormat: "openai",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    requiresApiKey: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    apiFormat: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    requiresApiKey: true,
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    apiFormat: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    requiresApiKey: true,
  },
  {
    id: "ollama",
    label: "Ollama (Local / Offline)",
    apiFormat: "openai",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "qwen2.5:14b",
    requiresApiKey: false,
  },
  {
    id: "custom",
    label: "Custom OpenAI Compatible",
    apiFormat: "openai",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    defaultModel: "default",
    requiresApiKey: false,
  },
];

function presetById(providerId) {
  return (
    DEBUG_BOT_PROVIDER_PRESETS.find((preset) => preset.id === providerId) ??
    DEBUG_BOT_PROVIDER_PRESETS[0]
  );
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeBaseUrl(rawUrl, fallbackUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return fallbackUrl;
  return trimmed.replace(/\/+$/, "");
}

export function getEnvDebugBotDefaults(env = process.env) {
  const providerRaw = String(
    env.DEBUG_BOT_PROVIDER || env.HERMES_PROVIDER || env.LLM_PROVIDER || "",
  )
    .trim()
    .toLowerCase();
  const baseUrlRaw = String(
    env.DEBUG_BOT_BASE_URL ||
      env.HERMES_BASE_URL ||
      env.LLM_BASE_URL ||
      env.OPENAI_BASE_URL ||
      "",
  ).trim();
  const apiKeyRaw = String(
    env.DEBUG_BOT_API_KEY ||
      env.HERMES_API_KEY ||
      env.LLM_API_KEY ||
      env.OPENAI_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      "",
  ).trim();
  const modelRaw = String(
    env.DEBUG_BOT_MODEL || env.HERMES_MODEL || env.LLM_MODEL || "",
  ).trim();

  let provider = providerRaw;
  if (!provider) {
    if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY && !env.LLM_API_KEY && !env.DEBUG_BOT_API_KEY) {
      provider = "anthropic";
    } else if (baseUrlRaw.includes("deepseek")) {
      provider = "deepseek";
    } else if (baseUrlRaw.includes("dashscope")) {
      provider = "qwen";
    } else if (baseUrlRaw.includes("openrouter")) {
      provider = "openrouter";
    } else if (baseUrlRaw.includes("11434")) {
      provider = "ollama";
    } else {
      provider = "deepseek";
    }
  }

  const preset = presetById(provider);
  return {
    provider: preset.id,
    apiFormat: preset.apiFormat,
    baseUrl: normalizeBaseUrl(baseUrlRaw, preset.defaultBaseUrl),
    apiKey: apiKeyRaw,
    model: modelRaw || preset.defaultModel,
    temperature: clampNumber(env.DEBUG_BOT_TEMPERATURE ?? env.HERMES_TEMPERATURE, 0.2, 0, 2),
    maxToolSteps: Math.round(
      clampNumber(env.DEBUG_BOT_MAX_TOOL_STEPS ?? env.HERMES_MAX_TOOL_STEPS, 8, 1, 16),
    ),
    systemPrompt: String(env.DEBUG_BOT_SYSTEM_PROMPT || env.HERMES_SYSTEM_PROMPT || "").trim(),
  };
}

export function normalizeDebugBotConfig(input, previous = null, env = process.env) {
  const defaults = previous ?? getEnvDebugBotDefaults(env);
  const providerId = String(input?.provider ?? defaults.provider ?? "deepseek")
    .trim()
    .toLowerCase();
  const preset = presetById(providerId);

  const incomingKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : undefined;
  let apiKey = defaults.apiKey ?? "";
  if (input?.clearApiKey === true) {
    apiKey = "";
  } else if (incomingKey) {
    apiKey = incomingKey;
  }

  const apiFormat =
    input?.apiFormat === "anthropic" || input?.apiFormat === "openai"
      ? input.apiFormat
      : preset.apiFormat;

  return {
    provider: preset.id,
    apiFormat,
    baseUrl: normalizeBaseUrl(input?.baseUrl ?? defaults.baseUrl, preset.defaultBaseUrl),
    apiKey,
    model:
      String(input?.model ?? defaults.model ?? preset.defaultModel).trim() || preset.defaultModel,
    temperature: clampNumber(input?.temperature, defaults.temperature ?? 0.2, 0, 2),
    maxToolSteps: Math.round(clampNumber(input?.maxToolSteps, defaults.maxToolSteps ?? 8, 1, 16)),
    systemPrompt: String(input?.systemPrompt ?? defaults.systemPrompt ?? "").trim(),
  };
}

export function maskApiKey(apiKey) {
  const trimmed = String(apiKey ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "••••••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export function maskDebugBotConfigForClient(config, source = "env") {
  const preset = presetById(config.provider);
  const hasApiKey = Boolean(String(config.apiKey ?? "").trim());
  return {
    provider: config.provider,
    apiFormat: config.apiFormat || preset.apiFormat,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxToolSteps: config.maxToolSteps,
    systemPrompt: config.systemPrompt || "",
    hasApiKey,
    apiKeyMasked: maskApiKey(config.apiKey),
    requiresApiKey: preset.requiresApiKey,
    configured: hasApiKey || !preset.requiresApiKey,
    source,
  };
}

async function ensureDebugBotConfigTable(queryFn) {
  await queryFn(`
    CREATE TABLE IF NOT EXISTS public.debug_bot_configurations (
      id TEXT PRIMARY KEY,
      configuration JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function loadDebugBotConfig({ queryFn = defaultQuery, env = process.env } = {}) {
  const envDefaults = getEnvDebugBotDefaults(env);
  try {
    await ensureDebugBotConfigTable(queryFn);
    const result = await queryFn(
      `
      SELECT configuration
      FROM public.debug_bot_configurations
      WHERE id = $1
      LIMIT 1
      `,
      [DEBUG_BOT_CONFIG_ID],
    );
    const stored = result.rows[0]?.configuration;
    if (stored && typeof stored === "object") {
      return {
        config: normalizeDebugBotConfig(stored, envDefaults, env),
        source: "database",
      };
    }
  } catch {
    // Fall back to environment defaults if PostgreSQL is not yet initialized.
  }
  return { config: envDefaults, source: "env" };
}

export async function saveDebugBotConfig(input, { queryFn = defaultQuery, env = process.env } = {}) {
  await ensureDebugBotConfigTable(queryFn);
  const { config: current } = await loadDebugBotConfig({ queryFn, env });
  const normalized = normalizeDebugBotConfig(input, current, env);

  await queryFn(
    `
    INSERT INTO public.debug_bot_configurations (id, configuration, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      configuration = EXCLUDED.configuration,
      updated_at = NOW()
    `,
    [DEBUG_BOT_CONFIG_ID, JSON.stringify(normalized)],
  );

  return { config: normalized, source: "database" };
}

export async function testDebugBotLlmConnection(
  rawInput,
  { queryFn = defaultQuery, env = process.env, fetchFn = fetch } = {},
) {
  const { config: current } = await loadDebugBotConfig({ queryFn, env });
  const config = normalizeDebugBotConfig(rawInput ?? {}, current, env);
  const preset = presetById(config.provider);

  if (preset.requiresApiKey && !config.apiKey) {
    throw Object.assign(new Error("API Key is required for the selected model provider."), {
      status: 400,
    });
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    if (config.apiFormat === "anthropic") {
      const response = await fetchFn(`${config.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with OK." }],
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          data?.error?.message || data?.message || `Anthropic API returned HTTP ${response.status}`;
        throw Object.assign(new Error(message), { status: 502 });
      }
      const reply = Array.isArray(data.content)
        ? data.content
            .filter((block) => block?.type === "text")
            .map((block) => block.text)
            .join("")
            .trim()
        : "";
      return {
        ok: true,
        provider: config.provider,
        model: data.model || config.model,
        latencyMs: Date.now() - startedAt,
        reply: reply || "OK",
      };
    }

    const headers = { "Content-Type": "application/json" };
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with OK." }],
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || `Model endpoint returned HTTP ${response.status}`;
      throw Object.assign(new Error(message), { status: 502 });
    }
    const reply = String(data?.choices?.[0]?.message?.content ?? "").trim();
    return {
      ok: true,
      provider: config.provider,
      model: data.model || config.model,
      latencyMs: Date.now() - startedAt,
      reply: reply || "OK",
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw Object.assign(new Error("Connection test timed out after 15 seconds."), {
        status: 504,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
