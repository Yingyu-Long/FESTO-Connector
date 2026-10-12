export const MODBUS_DATABLOCK_REGISTER_COUNT = 58;
export const MODBUS_DATABLOCK_DEFAULT_START_ADDRESS = 0;

export const MODBUS_DATABLOCK_FIELDS = Object.freeze(
  [
    {
      name: "timestamp_DI_IPos_ON",
      dataType: "ULINT",
      offset: 0,
      registerCount: 4,
    },
    {
      name: "timestamp_DI_IPos_OFF",
      dataType: "ULINT",
      offset: 4,
      registerCount: 4,
    },
    {
      name: "timestamp_DI_EPos_ON",
      dataType: "ULINT",
      offset: 8,
      registerCount: 4,
    },
    {
      name: "timestamp_DI_EPos_OFF",
      dataType: "ULINT",
      offset: 12,
      registerCount: 4,
    },
    {
      name: "timestamp_DO_MCtrl12_ON",
      dataType: "ULINT",
      offset: 16,
      registerCount: 4,
    },
    {
      name: "timestamp_DO_MCtrl12_OFF",
      dataType: "ULINT",
      offset: 20,
      registerCount: 4,
    },
    {
      name: "timestamp_DO_MCtrl14_ON",
      dataType: "ULINT",
      offset: 24,
      registerCount: 4,
    },
    {
      name: "timestamp_DO_MCtrl14_OFF",
      dataType: "ULINT",
      offset: 28,
      registerCount: 4,
    },
    {
      name: "udiCycleCounter",
      dataType: "UDINT",
      offset: 32,
      registerCount: 2,
    },
    {
      name: "sPartnumber",
      dataType: "STRING[48]",
      offset: 34,
      registerCount: 24,
    },
  ].map((field) => Object.freeze(field)),
);
