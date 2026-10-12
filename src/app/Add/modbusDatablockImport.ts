import { MODBUS_DATABLOCK_REGISTER_COUNT } from "../../../shared/modbusDatablock.js";

const maximumBlockCount = Math.floor(65536 / MODBUS_DATABLOCK_REGISTER_COUNT);

type ImportedDatablocks = {
  startAddress: number;
  polling: number;
  blockTopics: string[];
};

function integerCell(
  value: unknown,
  cell: string,
  minimum: number,
  maximum: number,
) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${cell}: enter a whole number from ${minimum} to ${maximum}.`);
  }
  return number;
}

function isEmpty(value: unknown) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function parseDatablockRows(rows: unknown[][]): ImportedDatablocks {
  for (const [row, column, label, cell] of [
    [0, 0, "Start address", "A1"],
    [1, 0, "Polling interval (ms)", "A2"],
    [3, 0, "FB", "A4"],
    [3, 1, "MQTT topic", "B4"],
  ] as const) {
    if (rows[row]?.[column] !== label) {
      throw new Error(`${cell}: expected "${label}". Use the Excel template.`);
    }
  }

  const startAddress = integerCell(
    rows[0]?.[1],
    "B1",
    0,
    65536 - MODBUS_DATABLOCK_REGISTER_COUNT,
  );
  const polling = integerCell(rows[1]?.[1], "B2", 10, 3600000);
  let declaredBlockCount: number | undefined;
  if (rows[2]?.[0] === "Number of Datablocks") {
    declaredBlockCount = integerCell(rows[2]?.[1], "B3", 1, maximumBlockCount);
  } else if (!isEmpty(rows[2]?.[0]) || !isEmpty(rows[2]?.[1])) {
    throw new Error('A3: expected "Number of Datablocks". Use the Excel template.');
  }

  const topics = new Map<number, string>();
  const encoder = new TextEncoder();
  for (let index = 4; index < rows.length; index += 1) {
    const [fb, topic] = rows[index];
    if (isEmpty(fb) && isEmpty(topic)) continue;
    const row = index + 1;
    const number = integerCell(fb, `A${row}`, 1, maximumBlockCount);
    if (topics.has(number)) {
      throw new Error(`A${row}: FB ${number} appears more than once.`);
    }
    if (typeof topic !== "string" || !topic.trim()) {
      throw new Error(`B${row}: enter an MQTT topic as text.`);
    }
    const trimmedTopic = topic.trim();
    if (
      /[+#\0]/.test(trimmedTopic) ||
      encoder.encode(trimmedTopic).length > 65535
    ) {
      throw new Error(
        `B${row}: MQTT topics must not contain +, # or null characters and must fit within 65535 UTF-8 bytes.`,
      );
    }
    topics.set(number, trimmedTopic);
  }
  if (topics.size === 0) {
    throw new Error("Add at least one FB and MQTT topic, starting on row 5.");
  }
  if (declaredBlockCount !== undefined && topics.size !== declaredBlockCount) {
    throw new Error(
      `B3 specifies ${declaredBlockCount} datablocks, but ${topics.size} FB rows were found. Match the FB rows to Number of Datablocks.`,
    );
  }

  const blockTopics = Array.from({ length: topics.size }, (_, index) => {
    const topic = topics.get(index + 1);
    if (topic === undefined) {
      throw new Error(
        `FB ${index + 1} is missing. Use consecutive FB numbers starting at 1.`,
      );
    }
    return topic;
  });
  const endAddress =
    startAddress + blockTopics.length * MODBUS_DATABLOCK_REGISTER_COUNT - 1;
  if (endAddress > 65535) {
    throw new Error(
      `These ${blockTopics.length} FBs end at register ${endAddress}. The last register must not exceed 65535.`,
    );
  }
  return { startAddress, polling, blockTopics };
}

export async function importDatablocks(file: File): Promise<ImportedDatablocks> {
  if (!/\.xlsx$/i.test(file.name)) {
    throw new Error(
      "Choose an Excel .xlsx file. Save legacy .xls files as .xlsx first.",
    );
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error("Choose an Excel file smaller than 10 MB.");
  }
  const { readSheet, SheetNotFoundError } = await import("read-excel-file/browser");
  let rows: unknown[][];
  try {
    rows = await readSheet(file, "Datablocks", { trim: false });
  } catch (error) {
    if (error instanceof SheetNotFoundError) {
      throw new Error(
        'The workbook must contain a sheet named "Datablocks". Use the Excel template.',
        { cause: error },
      );
    }
    throw new Error(
      "Unable to read this workbook. Save it as an unencrypted .xlsx file and try again.",
      { cause: error },
    );
  }
  return parseDatablockRows(rows);
}
