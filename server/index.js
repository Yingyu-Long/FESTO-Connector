import cors from "cors";
import express from "express";
import "dotenv/config";
import { query } from "./database.js";
import { testMqttConnection } from "./mqttPublisher.js";
import { browseOpcuaNodes, testOpcuaConnection } from "./plc/opcuaClient.js";
import { startOpcuaPoller, stopOpcuaPoller } from "./plc/opcuaPoller.js";
import { startSiemensPoller, stopSiemensPoller } from "./plc/poller.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_request, response) => {
  try {
    await query("SELECT 1");
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
    await startSiemensPoller(config);
    response.json({ connected: true, plcId: config.id });
  } catch (error) {
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

app.delete("/api/plcs/siemens/:id", (request, response) => {
  stopSiemensPoller(request.params.id);
  response.status(204).end();
});

function hasOpcuaEndpoint(config) {
  return Boolean(config?.host && config?.port);
}

function opcuaError(response, error) {
  response.status(502).json({
    connected: false,
    error:
      error instanceof Error ? error.message : "Unable to connect to OPC UA server",
  });
}

app.post("/api/plcs/opcua/test", async (request, response) => {
  if (!hasOpcuaEndpoint(request.body)) {
    response.status(400).json({ connected: false, error: "OPC UA host and port are required" });
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
  if (!hasOpcuaEndpoint(config) || !config?.id || !Array.isArray(config.nodeIds) || config.nodeIds.length === 0) {
    response.status(400).json({ connected: false, error: "OPC UA id, endpoint, and at least one NodeId are required" });
    return;
  }

  try {
    await startOpcuaPoller(config);
    response.json({ connected: true, plcId: config.id });
  } catch (error) {
    opcuaError(response, error);
  }
});

app.delete("/api/plcs/opcua/:id", async (request, response) => {
  await stopOpcuaPoller(request.params.id);
  response.status(204).end();
});

app.listen(port, () => {
  console.log(`PLC backend listening on http://localhost:${port}`);
});
