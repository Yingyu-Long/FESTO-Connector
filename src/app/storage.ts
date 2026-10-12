export interface SavedConnection {
  recordId?: string;
  id: string;
  protocol: string;
  host: string;
  port: string;
  details: string;
  status: "connected" | "disconnected" | "error";
  connectionError?: string;
  config?: Record<string, unknown>;
}

export function readJsonStorage(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

export function readSavedConnections(): SavedConnection[] {
  const saved = readJsonStorage("festo-connections");
  if (!Array.isArray(saved)) return [];
  return deduplicateConnections(
    saved.filter((value): value is SavedConnection =>
      value !== null && typeof value === "object" &&
      ["id", "protocol", "host", "port", "details"].every(
        (key) => typeof value[key] === "string",
      ) &&
      ["connected", "disconnected", "error"].includes(value.status),
    ),
  );
}

export function storeConnections(connections: SavedConnection[]) {
  localStorage.setItem(
    "festo-connections",
    JSON.stringify(deduplicateConnections(connections)),
  );
}

export function connectionKey(connection: SavedConnection) {
  return connection.recordId ?? `${connection.protocol}-${connection.id}`;
}

export function readMqttConfig(): Record<string, unknown> | undefined {
  const saved = readJsonStorage("festo-mqtt-config");
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  const config = saved as Record<string, unknown>;
  return typeof config.host === "string" && config.host ? config : undefined;
}

export function deduplicateConnections(connections: SavedConnection[]) {
  const seen = new Set<string>();
  return connections.filter((connection) => {
    const key = `${connection.protocol}:${connection.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function saveConnection(connection: SavedConnection) {
  const saved = readSavedConnections();
  let existingIndex = connection.recordId
    ? saved.findIndex((item) => item.recordId === connection.recordId)
    : -1;
  // Older/imported records may not share the editor's recordId. Replace the
  // logical connection so deduplication cannot retain its old status/config.
  if (existingIndex < 0) {
    existingIndex = saved.findIndex((item) =>
      item.protocol === connection.protocol && item.id === connection.id,
    );
  }
  const recordId = connection.recordId
    ?? saved[existingIndex]?.recordId
    ?? `${Date.now()}-${Math.random()}`;
  const nextConnection = { ...connection, recordId };
  if (existingIndex >= 0) {
    saved[existingIndex] = nextConnection;
  } else {
    saved.push(nextConnection);
  }
  storeConnections(saved);
}

export function configString(
  connection: SavedConnection | undefined,
  key: string,
  fallback: string,
) {
  const value = connection?.config?.[key];
  return typeof value === "string" ? value : fallback;
}
