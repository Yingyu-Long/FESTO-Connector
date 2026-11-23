import mqtt from "mqtt";

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;
const MAX_LATENCY_SAMPLES = 100;
const RATE_WINDOW_MS = 60_000;

const clients = new Map();
const pendingConnections = new Map();

function createInitialStats() {
  return {
    inFlightCount: 0,
    maxInFlightCount: 0,
    totalPublished: 0,
    totalErrors: 0,
    totalTimeouts: 0,
    lastPublishAt: null,
    lastPublishLatencyMs: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    recentLatenciesMs: [],
    recentPublishTimestamps: [],
  };
}

let publisherStats = createInitialStats();

function pruneRecentTimestamps(now) {
  const cutoff = now - RATE_WINDOW_MS;
  while (
    publisherStats.recentPublishTimestamps.length > 0 &&
    publisherStats.recentPublishTimestamps[0] < cutoff
  ) {
    publisherStats.recentPublishTimestamps.shift();
  }
}

export function resetMqttPublisherStats() {
  publisherStats = createInitialStats();
}

export function getMqttPublisherStats() {
  const now = Date.now();
  pruneRecentTimestamps(now);

  const latencies = publisherStats.recentLatenciesMs;
  let avgPublishLatencyMs = null;
  let p95PublishLatencyMs = null;
  let maxPublishLatencyMs = null;
  if (latencies.length > 0) {
    const sum = latencies.reduce((acc, v) => acc + v, 0);
    avgPublishLatencyMs = Number((sum / latencies.length).toFixed(1));
    const sorted = [...latencies].sort((a, b) => a - b);
    p95PublishLatencyMs = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    maxPublishLatencyMs = sorted[sorted.length - 1];
  }

  let recentPublishRatePerSec = 0;
  const recentCount = publisherStats.recentPublishTimestamps.length;
  if (recentCount > 0) {
    const oldest = publisherStats.recentPublishTimestamps[0];
    const spanSec = Math.max(1, Math.min(RATE_WINDOW_MS, now - oldest) / 1000);
    recentPublishRatePerSec = Number((recentCount / spanSec).toFixed(2));
  }

  let connectedClientCount = 0;
  let totalOutgoingBufferBytes = 0;
  for (const client of clients.values()) {
    if (client?.connected) connectedClientCount += 1;
    const writableLen = Number(client?.stream?.writableLength ?? 0);
    if (Number.isFinite(writableLen) && writableLen > 0) {
      totalOutgoingBufferBytes += writableLen;
    }
  }

  return {
    inFlightCount: publisherStats.inFlightCount,
    maxInFlightCount: publisherStats.maxInFlightCount,
    totalPublished: publisherStats.totalPublished,
    totalErrors: publisherStats.totalErrors,
    totalTimeouts: publisherStats.totalTimeouts,
    avgPublishLatencyMs,
    p95PublishLatencyMs,
    maxPublishLatencyMs,
    lastPublishLatencyMs: publisherStats.lastPublishLatencyMs,
    recentPublishRatePerSec,
    activeClientCount: clients.size,
    connectedClientCount,
    totalOutgoingBufferBytes,
    lastPublishAt: publisherStats.lastPublishAt
      ? new Date(publisherStats.lastPublishAt).toISOString()
      : null,
    lastErrorAt: publisherStats.lastErrorAt
      ? new Date(publisherStats.lastErrorAt).toISOString()
      : null,
    lastErrorMessage: publisherStats.lastErrorMessage,
  };
}

function clampTimeout(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

//get the mqtt url based on the configuration
function getMqttUrl(config) {
  const protocol = ["tcp://", "tcp:", "mqtt://", "mqtt:"].includes(
    config.protocol,
  )
    ? "mqtt://"
    : (config.protocol ?? "mqtt://");
  return `${protocol}${config.host}:${config.port}`;
}

function clientKey(config) {
  return JSON.stringify([
    getMqttUrl(config),
    config.username ?? "",
    config.password ?? "",
    config.clientId ?? "",
  ]);
}

function disposeClient(client) {
  if (!client) return;
  try {
    client.end(true);
  } catch {
    // Ignore cleanup errors on already-closed sockets.
  }
}

//get the mqtt client based on the configuration (single-flight with connect timeout)
async function getClient(config) {
  const url = getMqttUrl(config);
  const key = clientKey(config);
  const existingClient = clients.get(key);

  if (existingClient?.connected) return existingClient;

  const pending = pendingConnections.get(key);
  if (pending) return pending;

  if (existingClient) {
    clients.delete(key);
    disposeClient(existingClient);
  }

  const connectTimeout = clampTimeout(
    config.connectTimeout,
    DEFAULT_CONNECT_TIMEOUT_MS,
    500,
    15000,
  );

  const connectPromise = new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      clientId: config.clientId || undefined,
      username: config.username || undefined,
      password: config.password || undefined,
      connectTimeout,
      reconnectPeriod: 0,
    });

    let settled = false;
    const cleanupStartup = () => {
      clearTimeout(timer);
      client.removeListener("connect", handleConnect);
      client.removeListener("error", handleError);
      client.removeListener("close", handleClose);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanupStartup();
      disposeClient(client);
      reject(error);
    };

    const handleConnect = () => {
      if (settled) return;
      settled = true;
      cleanupStartup();
      // Keep an error listener attached so later socket drops never crash Node.
      client.on("error", () => {
        if (clients.get(key) === client) clients.delete(key);
      });
      client.on("close", () => {
        if (clients.get(key) === client) clients.delete(key);
      });
      clients.set(key, client);
      resolve(client);
    };

    const handleError = (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    };

    const handleClose = () => {
      fail(new Error(`MQTT broker closed connection before ready (${url})`));
    };

    const timer = setTimeout(() => {
      fail(new Error(`MQTT connection timed out after ${connectTimeout}ms (${url})`));
    }, connectTimeout);

    client.once("connect", handleConnect);
    client.once("error", handleError);
    client.once("close", handleClose);
  }).finally(() => {
    if (pendingConnections.get(key) === connectPromise) {
      pendingConnections.delete(key);
    }
  });

  pendingConnections.set(key, connectPromise);
  return connectPromise;
}

export async function publishPayload(config, topic, payload) {
  if (!config?.host || !topic) return false;

  const client = await getClient(config);
  const message = JSON.stringify(payload);
  const publishTimeout = clampTimeout(
    config.publishTimeout,
    DEFAULT_PUBLISH_TIMEOUT_MS,
    500,
    30000,
  );

  const startedAt = Date.now();
  publisherStats.inFlightCount += 1;
  if (publisherStats.inFlightCount > publisherStats.maxInFlightCount) {
    publisherStats.maxInFlightCount = publisherStats.inFlightCount;
  }

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        publisherStats.totalTimeouts += 1;
        reject(new Error(`MQTT publish timed out after ${publishTimeout}ms (${topic})`));
      }, publishTimeout);

      client.publish(
        topic,
        message,
        { qos: Number(config.qos ?? 1) },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      );
    });

    const completedAt = Date.now();
    const latencyMs = Math.max(0, completedAt - startedAt);
    publisherStats.totalPublished += 1;
    publisherStats.lastPublishAt = completedAt;
    publisherStats.lastPublishLatencyMs = latencyMs;
    publisherStats.recentLatenciesMs.push(latencyMs);
    if (publisherStats.recentLatenciesMs.length > MAX_LATENCY_SAMPLES) {
      publisherStats.recentLatenciesMs.shift();
    }
    publisherStats.recentPublishTimestamps.push(completedAt);
    pruneRecentTimestamps(completedAt);
    return true;
  } catch (error) {
    publisherStats.totalErrors += 1;
    publisherStats.lastErrorAt = Date.now();
    publisherStats.lastErrorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    publisherStats.inFlightCount = Math.max(0, publisherStats.inFlightCount - 1);
  }
}

export async function testMqttConnection(config) {
  if (!config?.host || !config?.port) {
    throw new Error("MQTT host and port are required");
  }

  await getClient(config);
  return true;
}

export function closeAllMqttClients() {
  for (const client of clients.values()) {
    disposeClient(client);
  }
  clients.clear();
  pendingConnections.clear();
}
