import { buildConfiguration } from "./configuration";
import { readSavedConnections } from "./storage";
import type { SavedConnection } from "./storage";

export async function connectPlc(
  endpoint: string,
  configuration: unknown,
  failureMessage: string,
): Promise<Pick<SavedConnection, "status" | "connectionError">> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configuration),
    });
    const result = (await response.json().catch(() => null)) as {
      connected?: boolean;
      error?: string;
    } | null;
    return response.ok && result?.connected
      ? { status: "connected", connectionError: undefined }
      : {
          status: "disconnected",
          connectionError: result?.error || failureMessage,
        };
  } catch {
    return {
      status: "disconnected",
      connectionError: "Unable to reach the PLC backend",
    };
  }
}

async function saveConfiguration(configuration: unknown) {
  const response = await fetch("/api/configuration", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configuration),
  });

  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      result?.error ?? "Unable to save configuration to the database",
    );
  }

  return response.json();
}

export async function loadConfiguration() {
  const response = await fetch("/api/configuration");

  if (!response.ok) {
    throw new Error("Unable to load configuration from the database");
  }

  return response.json();
}

export async function deleteConfigurationSource(uniqueKey: string) {
  const response = await fetch(
    `/api/configuration/message-sources/${encodeURIComponent(uniqueKey)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      result?.error ?? "Unable to delete configuration from the database",
    );
  }

  return response.json();
}

export async function saveCurrentConfiguration() {
  return saveConfiguration(buildConfiguration(readSavedConnections()));
}
