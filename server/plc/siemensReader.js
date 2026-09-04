import snap7 from "node-snap7";

function snap7Error(client, methodName, error) {
  if (error instanceof Error) return error;

  const code = Number(error ?? client.LastError?.());
  let description = "Unknown Snap7 error";
  try {
    if (Number.isFinite(code) && typeof client.ErrorText === "function") {
      description = client.ErrorText(code);
    }
  } catch {
    // Preserve the numeric code when Snap7 cannot translate it.
  }

  return new Error(`Snap7 ${methodName} failed (code ${code}): ${description}`);
}

// Snap7 client wrapper to use promises instead of callbacks.
function callClient(client, methodName, argumentsList) {
  return new Promise((resolve, reject) => {
    let callbackCalled = false;
    const callback = (error, data) => {
      callbackCalled = true;
      if (error) reject(snap7Error(client, methodName, error));
      else resolve(data);
    };
    let accepted;
    try {
      accepted = client[methodName](...argumentsList, callback);
    } catch (error) {
      reject(snap7Error(client, methodName, error));
      return;
    }

    if (accepted === false && !callbackCalled) {
      reject(snap7Error(client, methodName));
    }
  });
}

const MIP_STRING_FIELDS = [
  { name: "sCylinderID", offset: 2 },
  { name: "sValveID", offset: 52 },
  { name: "sValveterminalID", offset: 102 },
];

const MIP_TIME_FIELDS = [
  { name: "timestamp_DI_Pos_ON", offset: 500 },
  { name: "timestamp_DI_Pos_OFF", offset: 504 },
  { name: "timestamp_DI_EPos_ON", offset: 508 },
  { name: "timestamp_DI_EPos_OFF", offset: 512 },
  { name: "timestamp_DO_MCtrl_1", offset: 516 },
  { name: "timestamp_DO_MCtrl_2", offset: 520 },
  { name: "timestamp_DO_MCtrl_3", offset: 524 },
  { name: "timestamp_DO_MCtrl_4", offset: 528 },
];

//get the range of data blocks to read based on the configuration
export function parseDataBlockRange(range) {
  const match = String(range ?? "")
    .trim()
    .match(/^(?:DB)?(\d+)(?:\s*-\s*(\d+))?$/i);
  if (!match) return [];

  const first = Number(match[1]);
  const last = Math.min(Number(match[2] ?? match[1]), first + 199);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

async function readOneDataBlock(client, blockNumber, blockConfig) {
  const size =
    Number(blockConfig.size ?? 0) ||
    Number(
      (
        await callClient(client, "GetAgBlockInfo", [
          client.Block_DB,
          blockNumber,
        ])
      )?.MC7Size ?? 0,
    );

  if (!size) throw new Error(`Cannot determine size of DB${blockNumber}`);

  const buffer = await callClient(client, "DBRead", [
    blockNumber,
    Number(blockConfig.start ?? 0),
    size,
  ]);
  return {
    dataBlock: blockNumber,
    start: Number(blockConfig.start ?? 0),
    size,
    encoding: "base64",
    rawData: buffer.toString("base64"),
  };
}

function configuredMipDataBlock(config) {
  for (const block of config.dataBlocks ?? []) {
    const range = String(block?.range ?? "").trim();
    const match = range.match(/^(?:DB)?(\d+)(?:\s*,\s*.+)?$/i);
    if (match) return Number(match[1]);
  }

  throw new Error("Enter the MIP data block number, for example DB1");
}

function readS7String(buffer) {
  if (buffer.length < 2) throw new Error("Invalid S7 STRING value");

  const maximumLength = buffer[0];
  const actualLength = Math.min(buffer[1], maximumLength, buffer.length - 2);
  return {
    value: buffer.subarray(2, 2 + actualLength).toString("latin1"),
    maximumLength,
    actualLength,
  };
}

function mqttTopicSegment(identifier, fieldName, dataBlock, offset) {
  const text = String(identifier.value ?? "").trim();
  if (!text) {
    throw new Error(
      `${fieldName} is empty at DB${dataBlock} offset ${offset} ` +
        `(S7 STRING max length ${identifier.maximumLength}, current length ${identifier.actualLength})`,
    );
  }

  // Encode separators and MQTT wildcard characters inside PLC identifier values.
  return encodeURIComponent(text.replace(/\u0000/g, ""));
}

/**
 * Reads the fixed MIP layout without requesting the size of the complete DB.
 * TIME values are published as their signed millisecond values from the PLC.
 */
export async function readSiemensMipMessage(client, config) {
  const dataBlock = configuredMipDataBlock(config);
  const identifiers = {};

  for (const field of MIP_STRING_FIELDS) {
    const buffer = await callClient(client, "DBRead", [
      dataBlock,
      field.offset,
      50,
    ]);
    identifiers[field.name] = readS7String(Buffer.from(buffer));
  }

  const values = Buffer.from(
    await callClient(client, "DBRead", [dataBlock, 500, 36]),
  );
  if (values.length < 36) {
    throw new Error(`DB${dataBlock} returned an incomplete MIP output range`);
  }

  const payload = Object.fromEntries(
    MIP_TIME_FIELDS.map((field) => [
      field.name,
      values.readInt32BE(field.offset - 500),
    ]),
  );
  payload.udiCycleCounter = values.readUInt32BE(32);

  return {
    dataBlock,
    identifiers: {
      cylinderId: identifiers.sCylinderID.value,
      valveId: identifiers.sValveID.value,
      valveTerminalId: identifiers.sValveterminalID.value,
    },
    topic: [
      "festo-ax",
      "pni",
      mqttTopicSegment(
        identifiers.sValveterminalID,
        "sValveterminalID",
        dataBlock,
        102,
      ),
      mqttTopicSegment(identifiers.sValveID, "sValveID", dataBlock, 52),
      mqttTopicSegment(identifiers.sCylinderID, "sCylinderID", dataBlock, 2),
    ].join("/"),
    payload,
  };
}

export async function connectSiemens(config) {
  const client = new snap7.S7Client();
  await callClient(client, "ConnectTo", [
    config.host,
    Number(config.rack ?? 0),
    Number(config.slot ?? 1),
  ]);
  return client;
}

export async function readSiemensData(client, config) {
  const blocks = [];
  const errors = [];

  for (const blockConfig of config.dataBlocks ?? []) {
    for (const blockNumber of parseDataBlockRange(blockConfig.range)) {
      try {
        blocks.push(await readOneDataBlock(client, blockNumber, blockConfig));
      } catch (error) {
        errors.push({
          dataBlock: blockNumber,
          message:
            error instanceof Error
              ? error.message
              : `Snap7 data block read failed: ${String(error)}`,
        });
      }
    }
  }

  return {
    plcId: config.id,
    timestamp: Date.now(),
    dataBlocks: blocks,
    quality:
      errors.length === 0 ? "good" : blocks.length > 0 ? "partial" : "bad",
    errors,
  };
}
