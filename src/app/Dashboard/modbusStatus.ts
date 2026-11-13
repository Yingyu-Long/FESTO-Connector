import type { SavedConnection } from "../storage";
import { CUSTOMISED_ENDPOINT, CUSTOMISED_PROTOCOL } from "../../../shared/modbusCustomised.js";

export function isModbusConnection(connection: SavedConnection) {
  return connection.protocol === "modbus.tcp" || connection.protocol === CUSTOMISED_PROTOCOL;
}

export function modbusEndpoint(connection: SavedConnection) {
  return connection.protocol === CUSTOMISED_PROTOCOL ? CUSTOMISED_ENDPOINT : "/api/plcs/modbus";
}

export type ModbusConnectionStatus = {
  status: "connected" | "disconnected" | "unavailable";
  error?: string;
};

export function modbusStatusKey(connection: SavedConnection) {
  return JSON.stringify([
    connection.protocol,
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
  return isModbusConnection(connection)
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
  return isModbusConnection(connection)
    ? (liveStatus?.error || connection.connectionError)
    : connection.connectionError;
}

export async function loadModbusConnectionStatus(
  connection: SavedConnection,
  signal: AbortSignal,
): Promise<ModbusConnectionStatus> {
  try {
    const response = await fetch(
      `${modbusEndpoint(connection)}/${encodeURIComponent(connection.id.trim())}/status`,
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
