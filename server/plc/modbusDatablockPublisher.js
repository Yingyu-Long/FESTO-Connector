import { MODBUS_DATABLOCK_FIELDS } from "../../shared/modbusDatablock.js";

const timestampFields = MODBUS_DATABLOCK_FIELDS.filter(
  (field) => field.dataType === "ULINT",
);

function mqttPayload(values) {
  const payload = Object.fromEntries(timestampFields.map(({ name }) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} cannot be published as an exact JSON number: ${values[name]}`);
    }
    return [name, value];
  }));
  return {
    ...payload,
    cycle_counter: values.cycle_counter,
    part_number: values.part_number,
    isThisAutomaticMode: true,
  };
}

// Keep the last successfully delivered timestamp separately for every FB.
export function createModbusDatablockPublisher(publishPayload) {
  const lastPublished = new Map();
  let destination;

  return async (config, dataBlocks) => {
    const nextDestination = JSON.stringify(
      ["protocol", "host", "port", "username", "password", "clientId", "qos"].map(
        (key) => config.mqtt?.[key],
      ),
    );
    if (nextDestination !== destination) {
      lastPublished.clear();
      destination = nextDestination;
    }

    const blockKey = (block) => JSON.stringify([block.startAddress, block.topic]);
    const activeKeys = new Set(dataBlocks.map(blockKey));
    for (const key of lastPublished.keys()) {
      if (!activeKeys.has(key)) lastPublished.delete(key);
    }

    let published = true;
    for (const block of dataBlocks) {
      const key = blockKey(block);
      // The decoder supplies a decimal string, preserving all 64 bits.
      const timestamp = block.values.timestamp_DI_IPos_ON;
      if (
        config.testMode !== true &&
        lastPublished.has(key) &&
        lastPublished.get(key) === timestamp
      ) {
        continue;
      }

      const delivered = await publishPayload(config.mqtt, block.topic, mqttPayload(block.values));
      if (delivered) lastPublished.set(key, timestamp);
      published = published && delivered;
    }
    return published;
  };
}
