import { buildConfiguration } from "./configuration";
import { deduplicateConnections } from "./Add/storage";
import type { SavedConnection } from "./Add/storage";

export async function saveConfiguration(configuration: unknown) {
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
  const connections: SavedConnection[] = (() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("festo-connections") ?? "[]",
      );
      return Array.isArray(saved)
        ? deduplicateConnections(saved as SavedConnection[])
        : [];
    } catch {
      return [];
    }
  })();

  return saveConfiguration(buildConfiguration(connections));
}
