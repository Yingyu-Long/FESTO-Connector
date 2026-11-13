export const CUSTOMISED_PROTOCOL: "modbus.customised.tcp";
export const CUSTOMISED_ENDPOINT: "/api/plcs/modbus-customised";
export const CUSTOMISED_TYPES: Readonly<Record<string, number | null>>;
export type CustomisedField = { name: string; dataType: string; bitWidth: number | string };
export type CustomisedLayoutField = CustomisedField & { bitWidth: number; offset: number; registerCount: number };
export function customisedInteger(value: unknown, label: string, minimum: number, maximum: number): number;
export function buildCustomisedLayout(fields: unknown): { fields: CustomisedLayoutField[]; registerCount: number };
export function normaliseCustomisedConfig(config: unknown): Record<string, unknown> & {
  id: string; host: string; fields: CustomisedLayoutField[]; registersPerBlock: number;
  startAddress: number; blockCount: number; blockTopics: string[]; endian: string;
  port: number; unitId: number; timeout: number; polling: number;
};
export function customisedExampleFields(): CustomisedField[];
