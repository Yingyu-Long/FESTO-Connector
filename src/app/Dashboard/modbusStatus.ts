import type { SavedConnection } from "../storage";

export type ModbusConnectionStatus = {
  status: "connected" | "disconnected" | "unavailable";
  error?: string;
};

export function modbusStatusKey(connection: SavedConnection) {
  return JSON.stringify([
    connection.id.trim(),
    connection.host.trim(),
    Number(connection.port),
    Number(connection.config?.unitId ?? 1),
    Number(connection.config?.timeout ?? 3000),
  ]);
}

export function connectionDisplayStatus(
  connection: SavedConnection,
  liveStatus?: ModbusConnectionStatus,
) {
  return connection.protocol === "modbus.tcp"
    ? (liveStatus?.status ?? connection.status)
    : connection.status;
}

export function connectionDisplayError(
  connection: SavedConnection,
  liveStatus?: ModbusConnectionStatus,
) {
  if (connectionDisplayStatus(connection, liveStatus) === "connected") {
    return undefined;
  }
  return connection.protocol === "modbus.tcp"
    ? (liveStatus?.error || connection.connectionError)
    : connection.connectionError;
}

export async function loadModbusConnectionStatus(
  connection: SavedConnection,
  signal: AbortSignal,
): Promise<ModbusConnectionStatus> {
  try {
    const response = await fetch(
      `/api/plcs/modbus/${encodeURIComponent(connection.id.trim())}/status`,
      { signal },
    );
    if (!response.ok) throw new Error("Unable to read PLC status");
    const result = await response.json() as {
      pollingStatus?: string;
      error?: string;
    };
    if (["HEALTHY", "MQTT_NOT_CONFIGURED"].includes(result.pollingStatus ?? "")) {
      return { status: "connected" };
    }
    if (["UNHEALTHY", "NOT_CONNECTED"].includes(result.pollingStatus ?? "")) {
      return { status: "disconnected", error: result.error };
    }
    return { status: "unavailable", error: "PLC status is unavailable" };
  } catch {
    return { status: "unavailable", error: "Unable to read PLC status" };
  }
}
