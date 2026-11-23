import { setTimeout as delay } from "node:timers/promises";
import { MODBUS_DATABLOCK_DEFAULT_START_ADDRESS } from "../../shared/modbusDatablock.js";
import {
  CUSTOMISED_PROTOCOL,
  normaliseCustomisedConfig,
} from "../../shared/modbusCustomised.js";
import { normalizeModbusConfig } from "./modbusClient.js";
import {
  listActiveModbusPollers,
  startModbusPoller,
  stopModbusPoller,
  updateModbusPollerMqtt,
} from "./modbusPoller.js";
import { startCustomisedModbusPoller } from "./modbusCustomisedPoller.js";

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMqttProtocol(protocol) {
  if (!protocol) return "tcp://";
  if (["tcp:", "tcp://"].includes(protocol)) return "tcp://";
  if (["mqtt:", "mqtt://"].includes(protocol)) return "mqtt://";
  return protocol.endsWith("//") ? protocol : `${protocol}//`;
}

export function extractMqttConfigFromConfiguration(configuration) {
  const handler = configuration?.mqttMessageHandler;
  if (!isRecord(handler) || typeof handler.uri !== "string") return undefined;

  let parsed;
  try {
    parsed = new URL(handler.uri);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.trim();
  if (!host) return undefined;

  const basic = isRecord(handler.basicAuthentication)
    ? handler.basicAuthentication
    : null;
  const hasBasic = Boolean(
    basic && (typeof basic.username === "string" || typeof basic.password === "string"),
  );

  return {
    protocol: normalizeMqttProtocol(parsed.protocol),
    host,
    port: Number(parsed.port || 1883),
    clientId: typeof handler.clientId === "string" ? handler.clientId : "",
    qos: Number(handler.qos ?? 1),
    ...(hasBasic
      ? {
          authType: "Basic Authentication",
          username: String(basic.username ?? ""),
          password: String(basic.password ?? ""),
        }
      : { authType: "None" }),
  };
}

function canonicalMqttSpec(mqtt) {
  if (!isRecord(mqtt) || typeof mqtt.host !== "string" || !mqtt.host.trim()) {
    return null;
  }
  return JSON.stringify({
    protocol: normalizeMqttProtocol(mqtt.protocol),
    host: mqtt.host.trim().toLowerCase(),
    port: Number(mqtt.port ?? 1883),
    clientId: String(mqtt.clientId ?? ""),
    qos: Number(mqtt.qos ?? 1),
    username: String(mqtt.username ?? ""),
    password: String(mqtt.password ?? ""),
  });
}

function canonicalPollerSpec(config) {
  const base = {
    id: config.id,
    host: config.host.toLowerCase(),
    port: config.port,
    unitId: config.unitId,
    timeout: config.timeout,
    polling: config.polling,
    readMode: config.readMode,
    mqttTopic: config.mqttTopic ?? `festo/plc/${config.id}`,
  };
  if (config.readMode === "Read by Datablocks") {
    const layoutMode = config.layoutMode ?? "standard";
    return JSON.stringify({
      ...base,
      layoutMode,
      endian: config.endian ?? "Big-Endian",
      testMode: config.testMode === true,
      startAddress: config.startAddress,
      registerCount: config.registerCount ?? config.blockCount,
      blockTopics: config.blockTopics ?? [],
      ...(layoutMode === "custom"
        ? {
            fields: (config.fields ?? []).map((f) => ({
              name: f.name,
              dataType: f.dataType,
              bitWidth: f.bitWidth,
              offset: f.offset,
              registerCount: f.registerCount,
            })),
          }
        : {}),
    });
  }
  return JSON.stringify({
    ...base,
    registers: (config.registers ?? []).map((r) => ({
      name: r.name,
      registerType: r.registerType,
      address: r.address,
      dataType: r.dataType,
      length: r.length,
      wordOrder: r.wordOrder,
    })),
  });
}

export function extractModbusSourcesFromConfiguration(configuration) {
  if (!isRecord(configuration) || !Array.isArray(configuration.messageSources)) {
    return [];
  }

  const mqtt = extractMqttConfigFromConfiguration(configuration);
  const seen = new Set();
  const entries = [];

  for (const source of configuration.messageSources) {
    if (!isRecord(source) || typeof source.id !== "string" || typeof source.uri !== "string") {
      continue;
    }

    let uri;
    try {
      uri = new URL(source.uri);
    } catch {
      continue;
    }

    const protocol = uri.protocol.replace(":", "");
    if (protocol !== "modbus.tcp" && protocol !== CUSTOMISED_PROTOCOL) {
      continue;
    }

    const namespace = protocol === CUSTOMISED_PROTOCOL ? "customised" : "modbus";
    const id = source.id.trim();
    const dedupKey = JSON.stringify([namespace, id]);
    if (!id || seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const raw = isRecord(source.configuration)
      ? source.configuration
      : isRecord(source[`${protocol}Configuration`])
        ? source[`${protocol}Configuration`]
        : {};

    const host = uri.hostname || String(raw.host ?? "").trim();
    const port = Number(uri.port || raw.port || 502);

    try {
      if (namespace === "customised") {
        const normalized = normaliseCustomisedConfig({
          ...raw,
          id,
          host,
          port,
          blockCount: raw.blockCount ?? raw.registerCount,
          mqtt,
        });
        entries.push({
          namespace,
          id,
          config: {
            ...normalized,
            readMode: "Read by Datablocks",
            layoutMode: "custom",
            registerCount: normalized.blockCount,
          },
        });
      } else {
        const byDatablocks = raw.readMode === "Read by Datablocks";
        const candidate = {
          id,
          host,
          port,
          unitId: raw.unitId ?? 1,
          timeout: raw.timeout ?? 3000,
          polling: raw.polling ?? 500,
          readMode: byDatablocks ? "Read by Datablocks" : "Read by registers",
          ...(byDatablocks
            ? {
                layoutMode: raw.layoutMode ?? "standard",
                ...(raw.layoutMode === "custom" ? { fields: raw.fields } : {}),
                endian: raw.endian ?? "Big-Endian",
                testMode: raw.testMode === true,
                startAddress:
                  raw.startAddress === undefined
                    ? MODBUS_DATABLOCK_DEFAULT_START_ADDRESS
                    : raw.startAddress,
                registerCount: raw.registerCount,
                blockTopics: Array.isArray(raw.blockTopics) ? raw.blockTopics : [],
              }
            : {
                registers: Array.isArray(raw.registers) ? raw.registers : [],
              }),
          mqtt,
          mqttTopic: `festo/plc/${id}`,
        };
        const normalized = normalizeModbusConfig(candidate);
        entries.push({ namespace, id, config: normalized });
      }
    } catch (error) {
      console.error(`Skipping invalid saved Modbus configuration "${id}"`, error);
    }
  }

  return entries;
}

let syncQueue = Promise.resolve();

export function syncModbusPollersWithConfiguration(configuration, deps = {}) {
  const {
    listActive = listActiveModbusPollers,
    startStandard = startModbusPoller,
    startCustom = startCustomisedModbusPoller,
    stopPoller = stopModbusPoller,
    updateMqtt = updateModbusPollerMqtt,
    pollerOptions = {},
  } = deps;

  const task = syncQueue.then(async () => {
    const desired = extractModbusSourcesFromConfiguration(configuration);
    const desiredMap = new Map(
      desired.map((entry) => [JSON.stringify([entry.namespace, entry.id]), entry]),
    );
    const active = listActive();
    const activeMap = new Map(
      active.map((entry) => [JSON.stringify([entry.namespace, entry.id]), entry]),
    );

    const summary = {
      started: 0,
      updated: 0,
      mqttUpdated: 0,
      stopped: 0,
      unchanged: 0,
      failed: 0,
    };

    // 1. Stop any Modbus pollers that were removed from the saved configuration.
    await Promise.allSettled(
      active
        .filter((entry) => !desiredMap.has(JSON.stringify([entry.namespace, entry.id])))
        .map(async (entry) => {
          await stopPoller(entry.id, entry.namespace);
          summary.stopped++;
        }),
    );

    // 2. Start missing pollers, update changed pollers, and hot-reload MQTT settings.
    const startOptions = { keepAliveOnInitialError: true, ...pollerOptions };
    await Promise.allSettled(
      desired.map(async (entry) => {
        const key = JSON.stringify([entry.namespace, entry.id]);
        const current = activeMap.get(key);
        const startFn =
          entry.namespace === "customised"
            ? (cfg, opts) => startCustom(cfg, opts)
            : (cfg, opts) => startStandard(cfg, "modbus", opts);

        try {
          if (!current) {
            await startFn(entry.config, startOptions);
            summary.started++;
            return;
          }

          const sameSpec =
            canonicalPollerSpec(current.config) === canonicalPollerSpec(entry.config);
          const sameMqtt =
            canonicalMqttSpec(current.config.mqtt) === canonicalMqttSpec(entry.config.mqtt);

          if (!sameSpec) {
            await startFn(entry.config, startOptions);
            summary.updated++;
          } else if (!sameMqtt) {
            await updateMqtt(entry.id, entry.config.mqtt, entry.namespace);
            summary.mqttUpdated++;
          } else {
            summary.unchanged++;
          }
        } catch (error) {
          summary.failed++;
          console.error(`Unable to sync Modbus poller "${entry.id}"`, error);
        }
      }),
    );

    return summary;
  });

  syncQueue = task.catch(() => undefined);
  return task;
}

export async function restoreModbusPollersFromDatabase({
  queryFn,
  retryAttempts = 5,
  retryDelayMs = 2000,
  ...deps
}) {
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const result = await queryFn(
        `
        SELECT configuration
        FROM connector_configurations
        ORDER BY updated_at DESC
        LIMIT 1
        `,
      );
      const configuration = result.rows[0]?.configuration ?? null;
      if (!configuration) {
        return { restored: false, reason: "empty" };
      }
      const summary = await syncModbusPollersWithConfiguration(configuration, deps);
      console.log(
        `Restored saved Modbus pollers from database: started=${summary.started}, unchanged=${summary.unchanged}, failed=${summary.failed}`,
      );
      return { restored: true, summary };
    } catch (error) {
      if (attempt < retryAttempts) {
        console.warn(
          `Database unavailable during Modbus auto-restore (attempt ${attempt}/${retryAttempts}); retrying in ${retryDelayMs}ms`,
        );
        await delay(retryDelayMs);
      } else {
        console.error("Failed to auto-restore Modbus pollers from database", error);
        return { restored: false, error };
      }
    }
  }
  return { restored: false };
}
