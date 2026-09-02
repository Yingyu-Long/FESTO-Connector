import snap7 from "node-snap7";
//snap 7 client wrapper to use promises instead of callbacks

//
function callClient(client, methodName, argumentsList) {
  return new Promise((resolve, reject) => {
    let callbackCalled = false;
    const callback = (error, data) => {
      callbackCalled = true;
      if (error) reject(error);
      else resolve(data);
    };
    const accepted = client[methodName](...argumentsList, callback);

    if (accepted === false && !callbackCalled) {
      reject(new Error(`Snap7 ${methodName} failed`));
    }
  });
}

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
            error instanceof Error ? error.message : "Data block read failed",
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
