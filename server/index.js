import cors from "cors";
import express from "express";
import "dotenv/config";
import { testMqttConnection } from "./mqttPublisher.js";
import { startSiemensPoller, stopSiemensPoller } from "./plc/poller.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

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

app.listen(port, () => {
  console.log(`PLC backend listening on http://localhost:${port}`);
});
