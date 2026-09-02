import mqtt from "mqtt";

const clients = new Map();

//get the mqtt url based on the configuration
function getMqttUrl(config) {
  const protocol = ["tcp://", "tcp:", "mqtt://", "mqtt:"].includes(
    config.protocol,
  )
    ? "mqtt://"
    : (config.protocol ?? "mqtt://");
  return `${protocol}${config.host}:${config.port}`;
}

//get the mqtt client based on the configuration
async function getClient(config) {
  const url = getMqttUrl(config);
  const key = `${url}:${config.username ?? ""}:${config.clientId ?? ""}`;
  const existingClient = clients.get(key);

  if (existingClient?.connected) return existingClient;

  const client = mqtt.connect(url, {
    clientId: config.clientId || undefined,
    username: config.username || undefined,
    password: config.password || undefined,
    reconnectPeriod: 3000,
  });

  await new Promise((resolve, reject) => {
    const handleConnect = () => {
      client.removeListener("error", handleError);
      resolve();
    };
    const handleError = (error) => {
      client.removeListener("connect", handleConnect);
      reject(error);
    };
    client.once("connect", handleConnect);
    client.once("error", handleError);
  });

  clients.set(key, client);
  return client;
}

export async function publishPayload(config, topic, payload) {
  if (!config?.host || !topic) return false;

  const client = await getClient(config);
  await new Promise((resolve, reject) => {
    client.publish(
      topic,
      JSON.stringify(payload),
      { qos: Number(config.qos ?? 1) },
      (error) => (error ? reject(error) : resolve()),
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
