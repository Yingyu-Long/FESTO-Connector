import { IconCheckStatus, IconFailure, IconRefresh } from "@festo-ui/react-icons";
import type { SavedConnection } from "../storage";
import { CUSTOMISED_PROTOCOL, normaliseCustomisedConfig } from "../../../shared/modbusCustomised.js";
import {
  MODBUS_DATABLOCK_DEFAULT_START_ADDRESS,
  MODBUS_DATABLOCK_REGISTER_COUNT,
} from "../../../shared/modbusDatablock.js";

type DetailItem = {
  label: string;
  value: string;
  mqttTopic?: string;
};

type S7DataBlockStatus = {
  dataBlock: number | string;
  mqttTopic?: string;
  cylinderId?: string;
  valveId?: string;
  valveTerminalId?: string;
};

export type S7PollingStatus = {
  pollingStatus: string;
  dataBlocks: S7DataBlockStatus[];
  error?: string;
};

function connectionDetailItems(connection: SavedConnection): DetailItem[] {
  const config = connection.config ?? {};

  if (connection.protocol === CUSTOMISED_PROTOCOL || (connection.protocol === "modbus.tcp" && config.readMode === "Read by Datablocks" && config.layoutMode === "custom")) {
    try {
      const custom = normaliseCustomisedConfig({ ...config, blockCount: config.registerCount ?? config.blockCount, id: connection.id, host: connection.host, port: connection.port });
      return custom.blockTopics.map((topic, index) => {
        const start = custom.startAddress + index * custom.registersPerBlock;
        return {
          label: `Datablock ${index + 1}`,
          value: `Holding registers: ${start}–${start + custom.registersPerBlock - 1} | ${custom.fields.map((field) => `${field.name}: ${field.dataType === "STRING" ? `STRING[${field.bitWidth / 8}]` : field.dataType}`).join(", ")}`,
          mqttTopic: topic,
        };
      });
    } catch {
      return [{ label: "Invalid customised layout", value: "Edit this PLC to correct its configuration." }];
    }
  }

  if (connection.protocol === "opc.tcp") {
    const configuredBlocks = Array.isArray(config.dataBlocks) ? config.dataBlocks : [];
    if (configuredBlocks.length > 0) {
      return configuredBlocks.flatMap((raw, index) => {
        if (typeof raw !== "object" || raw === null) return [];
        const block = raw as Record<string, unknown>;
        const rawNodes = Array.isArray(block.nodes) && block.nodes.length > 0
          ? block.nodes
          : Array.isArray(block.selectedNodes) && block.selectedNodes.length > 0
            ? block.selectedNodes
            : Array.isArray(block.nodeIds)
              ? block.nodeIds.map((nodeId) => ({ nodeId }))
              : [];
        const nodes = rawNodes.flatMap((node) => {
          if (typeof node === "string") return [node];
          if (typeof node !== "object" || node === null) return [];
          const value = node as Record<string, unknown>;
          if (typeof value.nodeId !== "string") return [];
          const label = typeof value.displayName === "string" ? value.displayName : value.nodeId;
          return [`${label} (${value.nodeId})`];
        });
        const topic = typeof block.mqttTopic === "string" && block.mqttTopic.trim()
          ? block.mqttTopic.trim()
          : `festo/plc/${connection.id}${index === 0 ? "" : `/datablock-${index + 1}`}`;
        return [{
          label: typeof block.name === "string" && block.name.trim() ? block.name : `Datablock ${index + 1}`,
          value: nodes.join(", "),
          mqttTopic: topic,
        }];
      });
    }

    const selectedNodes = Array.isArray(config.selectedNodes)
      ? config.selectedNodes
      : [];
    const namedNodes = selectedNodes.flatMap((node) => {
      if (typeof node !== "object" || node === null) return [];
      const value = node as Record<string, unknown>;
      if (typeof value.nodeId !== "string") return [];
      return [
        {
          label:
            typeof value.displayName === "string"
              ? value.displayName
              : value.nodeId,
          value: value.nodeId,
        },
      ];
    });
    const fallbackNodes = namedNodes.length > 0
      ? namedNodes
      : Array.isArray(config.nodeIds)
        ? config.nodeIds
            .filter((nodeId): nodeId is string => typeof nodeId === "string")
            .map((nodeId) => ({ label: nodeId, value: nodeId }))
        : [];
    return fallbackNodes.length > 0
      ? [{
          label: "Datablock 1",
          value: fallbackNodes.map((node) => `${node.label} (${node.value})`).join(", "),
          mqttTopic: typeof config.mqttTopic === "string" && config.mqttTopic.trim()
            ? config.mqttTopic.trim()
            : `festo/plc/${connection.id}`,
        }]
      : [];
  }

  if (
    connection.protocol === "modbus.tcp" &&
    config.readMode === "Read by Datablocks"
  ) {
    const rawCount = config.registerCount;
    const rawStartAddress =
      config.startAddress === undefined
        ? MODBUS_DATABLOCK_DEFAULT_START_ADDRESS
        : config.startAddress;
    if (
      [rawCount, rawStartAddress].some(
        (value) =>
          (typeof value !== "number" && typeof value !== "string") ||
          (typeof value === "string" && !value.trim()),
      )
    ) {
      return [];
    }
    const count = Number(rawCount);
    const startAddress = Number(rawStartAddress);
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      !Number.isInteger(startAddress) ||
      startAddress < 0 ||
      startAddress + count * MODBUS_DATABLOCK_REGISTER_COUNT > 65536
    ) {
      return [];
    }
    const topics = Array.isArray(config.blockTopics) ? config.blockTopics : [];
    return Array.from({ length: count }, (_, index) => {
      const address = startAddress + index * MODBUS_DATABLOCK_REGISTER_COUNT;
      const endAddress = address + MODBUS_DATABLOCK_REGISTER_COUNT - 1;
      const topic =
        typeof topics[index] === "string" && topics[index].trim()
          ? topics[index]
          : "Not configured";
      return {
        label: `FB ${index + 1}`,
        value: `Holding registers: ${address}–${endAddress}`,
        mqttTopic: topic,
      };
    });
  }

  if (connection.protocol === "modbus.tcp" && Array.isArray(config.registers)) {
    return config.registers.flatMap((register) => {
      if (typeof register !== "object" || register === null) return [];
      const value = register as Record<string, unknown>;
      if (typeof value.name !== "string" || !value.name) return [];
      const details = [value.registerType, value.address, value.dataType]
        .filter(
          (item): item is string | number =>
            typeof item === "string" || typeof item === "number",
        )
        .join(" | ");
      return [{ label: value.name, value: details }];
    });
  }

  return [];
}

function hasDisplayableDetails(connection: SavedConnection) {
  const details = connection.details.trim();
  const normalizedDetails = details.toLowerCase();
  return (
    Boolean(details) &&
    !normalizedDetails.startsWith("uri:") &&
    !normalizedDetails.startsWith("remote-rack:")
  );
}

function configuredS7DataBlocks(
  connection: SavedConnection,
): S7DataBlockStatus[] {
  const dataBlocks = connection.config?.dataBlocks;
  if (!Array.isArray(dataBlocks)) return [];

  return dataBlocks.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const value = block as Record<string, unknown>;
    const range = value.dataBlock ?? value.range;
    if (typeof range !== "string" || !range) return [];
    return [{ dataBlock: range.replace(/^DB/i, "") }];
  });
}

function S7PollingLabel({ status }: { status: S7PollingStatus }) {
  const pollingStatus = status.pollingStatus || "METRICS_IN_CALCULATION";
  const isHealthy = pollingStatus === "HEALTHY";
  const isWarning = pollingStatus === "METRICS_IN_CALCULATION";

  return (
    <span
      className={`fwe-s7-polling-status${isHealthy ? " is-healthy" : ""}${isWarning ? " is-warning" : ""}`}
      title={status.error}
    >
      {isHealthy ? (
        <IconCheckStatus aria-hidden="true" />
      ) : isWarning ? (
        <IconRefresh aria-hidden="true" />
      ) : (
        <IconFailure aria-hidden="true" />
      )}
      {pollingStatus.replaceAll("_", " ")}
    </span>
  );
}

function S7DataBlockDetails({
  connection,
  status,
}: {
  connection: SavedConnection;
  status?: S7PollingStatus;
}) {
  const dataBlocks = status?.dataBlocks.length
    ? status.dataBlocks
    : configuredS7DataBlocks(connection);
  const pollingStatus = status ?? {
    pollingStatus: "METRICS_IN_CALCULATION",
    dataBlocks: [],
  };

  return (
    <section className="fwe-s7-data-blocks" aria-label="S7 data block status">
      <div className="fwe-s7-data-blocks-scroll">
        <table className="fwe-s7-data-blocks-table">
          <thead>
            <tr>
              <th>Data Block</th>
              <th>Cylinder Id</th>
              <th>Valve Id</th>
              <th>Valve Terminal Id</th>
              <th>MQTT topic</th>
              <th>Polling Status</th>
            </tr>
          </thead>
          <tbody>
            {dataBlocks.map((dataBlock) => (
              <tr key={String(dataBlock.dataBlock)}>
                <td>{String(dataBlock.dataBlock).replace(/^DB/i, "")}</td>
                <td>{dataBlock.cylinderId || "--"}</td>
                <td>{dataBlock.valveId || "--"}</td>
                <td>{dataBlock.valveTerminalId || "--"}</td>
                <td>{dataBlock.mqttTopic || (typeof connection.config?.mqttTopic === "string" && connection.config.mqttTopic.trim()) || "Automatic (PLC IDs)"}</td>
                <td>
                  <S7PollingLabel status={pollingStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ConnectionDetails({
  connection,
  s7Status,
  error,
}: {
  connection: SavedConnection;
  s7Status?: S7PollingStatus;
  error?: string;
}) {
  const byDatablocks =
    (connection.protocol === "modbus.tcp" || connection.protocol === CUSTOMISED_PROTOCOL) &&
    connection.config?.readMode === "Read by Datablocks";

  if (connection.protocol === "s7") {
    return (
      <div className="fwe-details">
        {error && <p className="fwe-connection-error">{error}</p>}
        <S7DataBlockDetails connection={connection} status={s7Status} />
      </div>
    );
  }

  const items = connectionDetailItems(connection);
  const heading =
    connection.protocol === "opc.tcp"
      ? "OPC UA Datablocks"
      : connection.protocol === "modbus.tcp" || connection.protocol === CUSTOMISED_PROTOCOL
        ? connection.config?.readMode === "Read by Datablocks"
          ? "Read by Datablocks"
          : "Read by registers"
        : "S7 data blocks";

  return (
    <div className="fwe-details">
      {error && <p className="fwe-connection-error">{error}</p>}
      {connection.protocol !== "modbus.tcp" &&
        hasDisplayableDetails(connection) && (
          <p className="fwe-details-message">{connection.details}</p>
        )}
      {items.length > 0 && (
        <section
          className={`fwe-detail-items${byDatablocks ? " fwe-datablock-details" : ""}`}
          aria-label={heading}
        >
          <h3>{heading}</h3>
          <ul
            className={byDatablocks ? "fwe-datablock-list" : undefined}
            tabIndex={byDatablocks ? 0 : undefined}
            aria-label={byDatablocks ? "Datablocks" : undefined}
          >
            {items.map((item) => (
              <li key={`${item.label}-${item.value}`}>
                <strong>{item.label}</strong>
                {item.value && <span>{item.value}</span>}
                {item.mqttTopic && (
                  <div className="fwe-detail-topic">
                    <span>MQTT topic</span>
                    <code>{item.mqttTopic}</code>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

