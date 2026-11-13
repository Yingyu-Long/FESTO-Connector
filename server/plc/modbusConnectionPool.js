import { connectModbus, disconnectModbus } from "./modbusClient.js";

// One socket per endpoint. Every request (including tests and different Unit
// IDs) joins the same queue, so single-client PLCs can serve multiple layouts.
const sessions = new Map();

export function acquireModbusConnection(config) {
  const key = JSON.stringify([config.host.toLowerCase(), config.port]);
  let session = sessions.get(key);
  if (!session) {
    session = { references: 0, client: undefined, queue: Promise.resolve() };
    sessions.set(key, session);
  }
  session.references++;
  let released = false;
  const enqueue = (operation) => {
    const result = session.queue.then(operation);
    session.queue = result.catch(() => undefined);
    return result;
  };
  return {
    run: (readConfig, operation) => {
      if (released) return Promise.reject(new Error("Modbus connection has been released"));
      return enqueue(async () => {
        try {
          if (!session.client?.isOpen) {
            await disconnectModbus(session.client);
            session.client = (await connectModbus(readConfig)).client;
          }
          session.client.setID?.(readConfig.unitId);
          session.client.setTimeout?.(readConfig.timeout);
          return await operation(session.client);
        } catch (error) {
          // An exception response (e.g. an invalid test address) leaves the
          // TCP stream usable; do not interrupt other acquisitions for it.
          if (!Number.isInteger(error?.modbusCode)) {
            await disconnectModbus(session.client);
            session.client = undefined;
          }
          throw error;
        }
      });
    },
    release: () => {
      if (released) return session.queue;
      released = true;
      session.references--;
      return enqueue(async () => {
        if (session.references !== 0) return;
        await disconnectModbus(session.client);
        session.client = undefined;
        if (session.references === 0 && sessions.get(key) === session) sessions.delete(key);
      });
    },
  };
}
