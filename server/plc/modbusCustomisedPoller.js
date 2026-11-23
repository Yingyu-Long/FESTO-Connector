// Compatibility for saved experimental connections; all acquisition now uses
// the unified poller and endpoint connection pool. Keep IDs namespaced so an
// old experimental record cannot replace a standard record with the same ID.
import { normaliseCustomisedConfig } from "../../shared/modbusCustomised.js";
import {
  getModbusPollerStatus, startModbusPoller, stopModbusPoller, testModbusPollerConnection,
} from "./modbusPoller.js";

function integratedConfig(rawConfig) {
  const config = normaliseCustomisedConfig({ ...rawConfig, blockCount: rawConfig.blockCount ?? rawConfig.registerCount });
  return { ...config, readMode: "Read by Datablocks", layoutMode: "custom", registerCount: config.blockCount };
}
export const getCustomisedModbusPollerStatus = (id) => getModbusPollerStatus(id, "customised");
export const stopCustomisedModbusPoller = (id) => stopModbusPoller(id, "customised");
export const startCustomisedModbusPoller = async (config, options) => startModbusPoller(integratedConfig(config), "customised", options);
export const testCustomisedModbusPollerConnection = async (config) => testModbusPollerConnection(integratedConfig(config));
