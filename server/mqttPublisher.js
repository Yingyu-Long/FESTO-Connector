import mqtt from "mqtt";

const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;

const clients = new Map();
const pendingConnections = new Map();

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

  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
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

  return true;
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
