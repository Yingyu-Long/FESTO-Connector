export interface SavedConnection {
  id: string;
  protocol: string;
  host: string;
  port: string;
  details: string;
  status: "disconnected";
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
  localStorage.setItem(
    "festo-connections",
    JSON.stringify([...saved, connection]),
  );
}
