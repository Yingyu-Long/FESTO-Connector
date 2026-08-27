export interface SavedConnection {
  recordId?: string;
  id: string;
  protocol: string;
  host: string;
  port: string;
  details: string;
  status: "connected" | "disconnected" | "error";
  editPath?: string;
  config?: Record<string, unknown>;
}

function readSavedConnections() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("festo-connections") ?? "[]",
    ) as SavedConnection[];
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function saveConnection(connection: SavedConnection) {
  const saved = readSavedConnections();
  const recordId = connection.recordId ?? `${Date.now()}-${Math.random()}`;
  const nextConnection = { ...connection, recordId };
  const existingIndex = saved.findIndex((item) => item.recordId === recordId);
  if (existingIndex >= 0) {
    saved[existingIndex] = nextConnection;
  } else {
    saved.push(nextConnection);
  }
  localStorage.setItem(
    "festo-connections",
    JSON.stringify(saved),
  );
}

export function configString(
  connection: SavedConnection | undefined,
  key: string,
  fallback: string,
) {
  const value = connection?.config?.[key];
  return typeof value === "string" ? value : fallback;
}
