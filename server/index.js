import cors from "cors";
import express from "express";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { query } from "./database.js";
import {
  closeAllMqttClients,
  resetMqttPublisherStats,
  testMqttConnection,
} from "./mqttPublisher.js";
import { browseOpcuaNodes, testOpcuaConnection } from "./plc/opcuaClient.js";
import {
  ModbusConfigurationError,
  normalizeModbusConfig,
  modbusErrorMessage,
} from "./plc/modbusClient.js";
import {
  getModbusPollerStatus,
  listModbusDatablockPollers,
  runModbusTestModePublish,
  startModbusPoller,
  stopAllModbusPollers,
  stopModbusPoller,
  testModbusPollerConnection,
} from "./plc/modbusPoller.js";
import {
  restoreModbusPollersFromDatabase,
  syncModbusPollersWithConfiguration,
} from "./plc/modbusBootstrap.js";
import {
  DEBUG_BOT_PROVIDER_PRESETS,
  loadDebugBotConfig,
  maskDebugBotConfigForClient,
  saveDebugBotConfig,
  testDebugBotLlmConnection,
} from "./debugBot/configStore.js";
import {
  executeDebugBotTool,
  listDebugBotTools,
  runDebugBotChat,
} from "./debugBot/agentEngine.js";
import { recordDiagnosticEvent } from "./debugBot/diagnosticLog.js";
import {
  normalizeOpcuaDataBlocks,
  startOpcuaPoller,
  stopOpcuaPoller,
} from "./plc/opcuaPoller.js";
import { CUSTOMISED_ENDPOINT, normaliseCustomisedConfig } from "../shared/modbusCustomised.js";
import {
  getCustomisedModbusPollerStatus,
  startCustomisedModbusPoller,
  stopCustomisedModbusPoller,
  testCustomisedModbusPollerConnection,
} from "./plc/modbusCustomisedPoller.js";
import {
  getSiemensPollerStatus,
  startSiemensPoller,
  stopSiemensPoller,
} from "./plc/poller.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_request, response) => {
  try {
    await query("SELECT 1 FROM public.connector_configurations LIMIT 0");
    response.json({ ok: true, database: true });
  } catch (error) {
    console.error("Database health check failed", error);
    response.status(503).json({
      ok: false,
      database: false,
      error: error instanceof Error ? error.message : "Database unavailable",
    });
  }
});

function isConnectorConfiguration(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    Array.isArray(value.messageSources) &&
    value.mqttMessageHandler &&
    typeof value.mqttMessageHandler === "object",
  );
}

app.get("/api/configuration", async (_request, response) => {
  try {
    const result = await query(
      `
      SELECT configuration
      FROM connector_configurations
      ORDER BY updated_at DESC
      LIMIT 1
      `,
    );
    response.json(result.rows[0]?.configuration ?? null);
  } catch (error) {
    console.error("Unable to load configuration", error);
    response.status(500).json({ error: "Unable to load configuration" });
  }
});

app.put("/api/configuration", async (request, response) => {
  const configuration = request.body;

  if (!isConnectorConfiguration(configuration)) {
    response.status(400).json({ error: "Invalid connector configuration" });
    return;
  }

  try {
    await query(
      `
      INSERT INTO connector_configurations
        (id, configuration, updated_at)
      VALUES
        ($1, $2::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        configuration = EXCLUDED.configuration,
        updated_at = NOW()
      `,
      [configuration.id, JSON.stringify(configuration)],
    );
    void syncModbusPollersWithConfiguration(configuration).catch((error) => {
      console.error("Failed to sync Modbus pollers after configuration update", error);
    });
    response.json({ saved: true, id: configuration.id });
  } catch (error) {
    console.error("Unable to save configuration", error);
    response.status(500).json({ error: "Unable to save configuration" });
  }
});

app.delete(
  "/api/configuration/message-sources/:uniqueKey",
  async (request, response) => {
    try {
      const result = await query(
        `
      UPDATE connector_configurations
      SET
        configuration = jsonb_set(
          configuration,
          '{messageSources}',
          COALESCE(
            (
              SELECT jsonb_agg(source)
              FROM jsonb_array_elements(configuration->'messageSources') AS source
              WHERE source->>'uniqueKey' <> $1
            ),
            '[]'::jsonb
          ),
          true
        ),
        updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM connector_configurations
        ORDER BY updated_at DESC
        LIMIT 1
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(configuration->'messageSources') AS source
        WHERE source->>'uniqueKey' = $1
      )
      RETURNING configuration
      `,
        [request.params.uniqueKey],
      );

      if (result.rowCount === 0) {
        response.status(404).json({ error: "Message source not found" });
        return;
      }

      response.json({
        deleted: true,
        configuration: result.rows[0].configuration,
      });
    } catch (error) {
      console.error("Unable to delete message source", error);
      response.status(500).json({ error: "Unable to delete message source" });
    }
  },
);

app.post("/api/mqtt/connect", async (request, response) => {
  try {
    await testMqttConnection(request.body);
    response.json({ connected: true });
  } catch (error) {
    response.status(502).json({
      connected: false,
      error:
        error instanceof Error
          ? error.message
          : "Unable to connect to MQTT broker",
    });
  }
});

app.post("/api/plcs/siemens/connect", async (request, response) => {
  const config = request.body;

  if (!config?.id || !config?.host || !Array.isArray(config.dataBlocks)) {
    response
      .status(400)
      .json({ connected: false, error: "Invalid Siemens configuration" });
    return;
  }

  try {
    if (config.previousId && String(config.previousId) !== String(config.id)) {
      stopSiemensPoller(config.previousId);
    }
    await startSiemensPoller(config);
    response.json({ connected: true, plcId: config.id });
  } catch (error) {
    console.error(`Siemens PLC ${config.id} connection failed`, error);
    response.status(502).json({
      connected: false,
      plcId: config.id,
      error:
        error instanceof Error
          ? error.message
          : "Unable to connect to Siemens PLC",
    });
  }
});

app.get("/api/plcs/siemens/:id/status", (request, response) => {
  response.json(getSiemensPollerStatus(request.params.id));
});

app.delete("/api/plcs/siemens/:id", (request, response) => {
  stopSiemensPoller(request.params.id);
  response.status(204).end();
});

function modbusError(response, error) {
  const invalidConfiguration = error instanceof ModbusConfigurationError;
  response.status(invalidConfiguration ? 400 : 502).json({
    connected: false,
    error: modbusErrorMessage(error),
  });
}

app.post("/api/plcs/modbus/test", async (request, response) => {
  try {
    const sample = await testModbusPollerConnection(request.body);
    response.json({ connected: true, sample });
  } catch (error) {
    modbusError(response, error);
  }
});

app.post("/api/plcs/modbus/connect", async (request, response) => {
  try {
    const config = normalizeModbusConfig(request.body);
    const result = await startModbusPoller(config);
    if (config.previousId && String(config.previousId) !== config.id) {
      await stopModbusPoller(config.previousId);
    }
    response.json({ connected: true, plcId: config.id, ...result });
  } catch (error) {
    console.error(`Modbus PLC ${request.body?.id} connection failed`, error);
    modbusError(response, error);
  }
});

app.get("/api/plcs/modbus/:id/status", (request, response) => {
  response.json(getModbusPollerStatus(request.params.id));
});

app.delete("/api/plcs/modbus/:id", async (request, response) => {
  await stopModbusPoller(request.params.id);
  response.status(204).end();
});

// Compatibility endpoints for saved experimental records; transport is shared.
for (const action of ["test", "connect"]) {
  app.post(`${CUSTOMISED_ENDPOINT}/${action}`, async (request, response) => {
    let config;
    try {
      config = normaliseCustomisedConfig(request.body);
    } catch (error) {
      response.status(400).json({ connected: false, error: modbusErrorMessage(error) });
      return;
    }
    try {
      if (action === "test") {
        const sample = await testCustomisedModbusPollerConnection(config);
        response.json({ connected: true, sample });
      } else {
        if (config.previousId && String(config.previousId) !== config.id) {
          await stopCustomisedModbusPoller(config.previousId);
        }
        const result = await startCustomisedModbusPoller(config);
        response.json({ connected: true, plcId: config.id, ...result });
      }
    } catch (error) {
      response.status(502).json({ connected: false, error: modbusErrorMessage(error) });
    }
  });
}
app.get(`${CUSTOMISED_ENDPOINT}/:id/status`, (request, response) => {
  response.json(getCustomisedModbusPollerStatus(request.params.id));
});
app.delete(`${CUSTOMISED_ENDPOINT}/:id`, async (request, response) => {
  await stopCustomisedModbusPoller(request.params.id);
  response.status(204).end();
});

function hasOpcuaEndpoint(config) {
  return Boolean(config?.host && config?.port);
}

function opcuaError(response, error) {
  response.status(502).json({
    connected: false,
    error:
      error instanceof Error
        ? error.message
        : "Unable to connect to OPC UA server",
  });
}

app.post("/api/plcs/opcua/test", async (request, response) => {
  if (!hasOpcuaEndpoint(request.body)) {
    response
      .status(400)
      .json({ connected: false, error: "OPC UA host and port are required" });
    return;
  }

  try {
    await testOpcuaConnection(request.body);
    response.json({ connected: true });
  } catch (error) {
    opcuaError(response, error);
  }
});

app.post("/api/plcs/opcua/browse", async (request, response) => {
  if (!hasOpcuaEndpoint(request.body)) {
    response.status(400).json({ error: "OPC UA host and port are required" });
    return;
  }

  try {
    const nodes = await browseOpcuaNodes(request.body, request.body.nodeId);
    response.json({ nodes });
  } catch (error) {
    opcuaError(response, error);
  }
});

app.post("/api/plcs/opcua/connect", async (request, response) => {
  const config = request.body;
  if (
    !hasOpcuaEndpoint(config) ||
    !config?.id
  ) {
    response
      .status(400)
      .json({
        connected: false,
        error: "OPC UA id and endpoint are required",
      });
    return;
  }

  let dataBlocks;
  try {
    dataBlocks = normalizeOpcuaDataBlocks(config);
  } catch (error) {
    response.status(400).json({
      connected: false,
      error: error instanceof Error ? error.message : "Invalid OPC UA Datablocks",
    });
    return;
  }

  try {
    if (config.previousId && String(config.previousId) !== String(config.id)) {
      await stopOpcuaPoller(config.previousId);
    }
    await startOpcuaPoller({ ...config, dataBlocks });
    response.json({ connected: true, plcId: config.id });
  } catch (error) {
    opcuaError(response, error);
  }
});

app.delete("/api/plcs/opcua/:id", async (request, response) => {
  await stopOpcuaPoller(request.params.id);
  response.status(204).end();
});

// Debug Bot routes (Multi-customer LLM settings + live Connector diagnostic skills)
app.get("/api/debug-bot/config", async (_request, response) => {
  try {
    const { config, source } = await loadDebugBotConfig({ queryFn: query });
    response.json({
      config: maskDebugBotConfigForClient(config, source),
      presets: DEBUG_BOT_PROVIDER_PRESETS,
    });
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to load Debug Bot configuration",
    });
  }
});

app.put("/api/debug-bot/config", async (request, response) => {
  try {
    const { config, source } = await saveDebugBotConfig(request.body ?? {}, {
      queryFn: query,
    });
    response.json({
      saved: true,
      config: maskDebugBotConfigForClient(config, source),
    });
  } catch (error) {
    response.status(error?.status || 500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to save Debug Bot configuration",
    });
  }
});

app.post("/api/debug-bot/config/test", async (request, response) => {
  try {
    const result = await testDebugBotLlmConnection(request.body ?? {}, {
      queryFn: query,
    });
    response.json(result);
  } catch (error) {
    response.status(error?.status || 502).json({
      ok: false,
      error:
        error instanceof Error ? error.message : "Model connection test failed",
    });
  }
});

app.get("/api/debug-bot/tools", (_request, response) => {
  response.json({ tools: listDebugBotTools() });
});

app.get("/api/debug-bot/modbus-pollers", (_request, response) => {
  response.json({ pollers: listModbusDatablockPollers() });
});

app.post("/api/debug-bot/test-mode", async (request, response) => {
  try {
    const body = request.body ?? {};
    const plcId =
      typeof body.plcId === "string" && body.plcId.trim() ? body.plcId.trim() : null;
    const durationSeconds = Number(body.durationSeconds ?? 0);
    const result = await runModbusTestModePublish({
      plcId,
      durationSeconds,
    });
    response.json(result);
  } catch (error) {
    response.status(error?.status || 500).json({
      ok: false,
      found: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to run Modbus Test Mode publish",
    });
  }
});

app.post("/api/debug-bot/backlog/reset", (_request, response) => {
  resetMqttPublisherStats();
  response.json({ ok: true });
});

app.post("/api/debug-bot/tool", async (request, response) => {
  try {
    const body = request.body ?? {};
    if (typeof body.tool !== "string" || !body.tool.trim()) {
      response.status(400).json({ ok: false, error: "Tool name is required" });
      return;
    }
    const execution = await executeDebugBotTool(
      body.tool.trim(),
      body.arguments ?? {},
      { queryFn: query },
    );
    response.status(execution.ok ? 200 : 502).json(execution);
  } catch (error) {
    response.status(error?.status || 500).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to execute Debug Bot tool",
    });
  }
});

app.post("/api/debug-bot/chat", async (request, response) => {
  try {
    const body = request.body ?? {};
    const { config } = await loadDebugBotConfig({ queryFn: query });
    const result = await runDebugBotChat({
      messages: body.messages,
      language: body.language === "en" ? "en" : "zh",
      config,
      context: { queryFn: query },
    });
    response.json(result);
  } catch (error) {
    response.status(error?.status || 500).json({
      error:
        error instanceof Error ? error.message : "Debug Bot request failed",
      code: error?.code || "DEBUG_BOT_CHAT_FAILED",
    });
  }
});

if (process.env.NODE_ENV === "production") {
  const frontendDirectory = fileURLToPath(new URL("../dist/", import.meta.url));

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API endpoint not found" });
  });

  app.use(express.static(frontendDirectory));
  app.get("/{*path}", (request, response, next) => {
    if (
      request.path === "/assets" ||
      request.path.startsWith("/assets/") ||
      extname(request.path) ||
      !request.accepts("html")
    ) {
      next();
      return;
    }

    response.sendFile("index.html", { root: frontendDirectory });
  });
}

const server = app.listen(port, () => {
  console.log(`PLC backend listening on http://localhost:${port}`);
  recordDiagnosticEvent({
    level: "info",
    component: "server",
    message: `Connector backend started on port ${port}`,
  });
  void restoreModbusPollersFromDatabase({ queryFn: query }).then((result) => {
    if (result?.restored && result.summary) {
      recordDiagnosticEvent({
        level: result.summary.failed > 0 ? "warn" : "info",
        component: "bootstrap",
        message: `Auto-restored Modbus pollers from PostgreSQL (started=${result.summary.started}, failed=${result.summary.failed})`,
      });
    }
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; closing PLC and MQTT connections...`);
  server.close();
  try {
    await stopAllModbusPollers();
    closeAllMqttClients();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
