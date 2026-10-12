import type { CellObject, SheetData } from "write-excel-file/browser";
import { MODBUS_DATABLOCK_REGISTER_COUNT } from "../../../shared/modbusDatablock.js";

type TemplateSettings = {
  blockCount: number;
  startAddress: number;
  polling: number;
  blockTopics: string[];
};

function createDatablockTemplateRows(settings: TemplateSettings): SheetData {
  const { blockCount, startAddress, polling, blockTopics } = settings;
  if (
    !Number.isInteger(blockCount) ||
    blockCount < 1 ||
    !Number.isInteger(startAddress) ||
    startAddress < 0 ||
    startAddress + blockCount * MODBUS_DATABLOCK_REGISTER_COUNT > 65536
  ) {
    throw new Error(
      "Enter a valid Number of Datablocks and Start address before downloading.",
    );
  }
  if (!Number.isInteger(polling) || polling < 10 || polling > 3600000) {
    throw new Error(
      "Enter a polling interval from 10 to 3600000 ms before downloading.",
    );
  }

  const body: CellObject = {
    height: 23,
    alignVertical: "center",
    textColor: "#263746",
  };
  const label: CellObject = {
    ...body,
    type: String,
    fontWeight: "bold",
    backgroundColor: "#EDF2F6",
  };
  const number: CellObject = {
    ...body,
    type: Number,
    format: "0",
    align: "right",
    backgroundColor: "#FFF2CC",
  };
  const header: CellObject = {
    ...body,
    type: String,
    fontWeight: "bold",
    textColor: "#FFFFFF",
    backgroundColor: "#006EB6",
    align: "center",
  };

  return [
    [{ ...label, value: "Start address" }, { ...number, value: startAddress }],
    [{ ...label, value: "Polling interval (ms)" }, { ...number, value: polling }],
    [{ ...label, value: "Number of Datablocks" }, { ...number, value: blockCount }],
    [{ ...header, value: "FB" }, { ...header, value: "MQTT topic" }],
    ...Array.from({ length: blockCount }, (_, index): CellObject[] => [
      { ...body, type: Number, value: index + 1, format: "0", align: "right" },
      {
        ...body,
        type: String,
        format: "@",
        backgroundColor: "#FFF2CC",
        value:
          blockTopics[index]?.trim() ||
          `test/fb${String(index + 1).padStart(2, "0")}`,
      },
    ]),
  ];
}

export async function downloadDatablockTemplate(settings: TemplateSettings) {
  const rows = createDatablockTemplateRows(settings);
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  await writeXlsxFile(
    rows,
    {
      sheet: "Datablocks",
      columns: [{ width: 27 }, { width: 48 }],
      showGridLines: false,
      stickyRowsCount: 4,
    },
    { fontFamily: "Arial", fontSize: 11 },
  ).toFile("modbus-datablocks-template.xlsx");
}
