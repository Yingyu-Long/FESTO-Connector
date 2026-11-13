import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";

test("OPC UA Datablocks publish the latest grouped values to their MQTT topic", async (t) => {
  const monitoredItems = [];
  const messages = [];
  const subscription = new EventEmitter();
  subscription.terminate = async () => {};
  const session = {};
  const connection = { client: {}, session };

  mock.module("node-opcua", {
    namedExports: {
      AttributeIds: { Value: 13 },
      ClientMonitoredItem: {
        create: (_subscription, request) => {
          const item = new EventEmitter();
          monitoredItems.push({ item, nodeId: request.nodeId });
          return item;
        },
      },
      ClientSubscription: {
        create: () => {
          queueMicrotask(() => subscription.emit("started"));
          return subscription;
        },
      },
      DataType: { 6: "Double" },
      TimestampsToReturn: { Both: 2 },
    },
  });
  mock.module(new URL("../server/mqttPublisher.js", import.meta.url).href, {
    namedExports: {
      publishPayload: async (_mqtt, topic, payload) => {
        messages.push({ topic, payload: structuredClone(payload) });
        return true;
      },
    },
  });
  mock.module(new URL("../server/plc/opcuaClient.js", import.meta.url).href, {
    namedExports: {
      connectOpcua: async () => connection,
      disconnectOpcua: async () => {},
    },
  });

  const { startOpcuaPoller, stopOpcuaPoller, normalizeOpcuaDataBlocks } =
    await import("../server/plc/opcuaPoller.js");
  const config = {
    id: "test-plc",
    polling: 100,
    mqtt: { host: "broker", port: 1883 },
    dataBlocks: [{
      name: "Temperatures",
      mqttTopic: "factory/temperatures",
      nodes: [
        { nodeId: "ns=2;s=Temperature1", displayName: "Temperature 1" },
        { nodeId: "ns=2;s=Temperature2", displayName: "Temperature 2" },
      ],
    }],
  };
  t.after(() => stopOpcuaPoller(config.id));

  assert.deepEqual(normalizeOpcuaDataBlocks(config), config.dataBlocks);
  await startOpcuaPoller(config);
  assert.equal(monitoredItems.length, 2);
  assert.equal(messages.length, 0);

  const emitValue = (nodeId, value, timestamp) => {
    const monitored = monitoredItems.find((entry) => entry.nodeId === nodeId);
    monitored.item.emit("changed", {
      value: { value, dataType: 6 },
      sourceTimestamp: new Date(timestamp),
      statusCode: { toString: () => "Good" },
    });
  };
  emitValue("ns=2;s=Temperature1", 20.5, "2026-01-01T00:00:00.000Z");
  assert.equal(messages.length, 0, "wait until every variable has an initial value");
  emitValue("ns=2;s=Temperature2", 21.5, "2026-01-01T00:00:01.000Z");
  assert.deepEqual(messages, [{
    topic: "factory/temperatures",
    payload: {
      plcId: "test-plc",
      dataBlock: "Temperatures",
      values: [
        {
          nodeId: "ns=2;s=Temperature1",
          name: "Temperature 1",
          value: 20.5,
          dataType: "Double",
          timestamp: "2026-01-01T00:00:00.000Z",
          statusCode: "Good",
        },
        {
          nodeId: "ns=2;s=Temperature2",
          name: "Temperature 2",
          value: 21.5,
          dataType: "Double",
          timestamp: "2026-01-01T00:00:01.000Z",
          statusCode: "Good",
        },
      ],
    },
  }]);

  emitValue("ns=2;s=Temperature1", 22, "2026-01-01T00:00:02.000Z");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].topic, "factory/temperatures");
  assert.equal(messages[1].payload.values[0].value, 22);
  assert.equal(messages[1].payload.values[1].value, 21.5);
});
