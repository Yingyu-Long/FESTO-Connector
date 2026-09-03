import {
  MessageSecurityMode,
  NodeClass,
  OPCUAClient,
  SecurityPolicy,
} from "node-opcua";

function endpointUrl(config) {
  const serverPath = String(config.server ?? "").trim().replace(/^\/+/, "");
  return `opc.tcp://${config.host}:${Number(config.port ?? 4840)}${serverPath ? `/${serverPath}` : ""}`;
}

export function assertAnonymousNoSecurity(config) {
  const securityMode = config.securityMode ?? "NONE_MODE";
  const authType = config.authType ?? "None";

  if (securityMode !== "NONE_MODE" || authType !== "None") {
    throw new Error(
      "This OPC UA version supports anonymous connections with NONE_MODE only",
    );
  }
}

export async function connectOpcua(config) {
  assertAnonymousNoSecurity(config);

  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    connectionStrategy: { initialDelay: 250, maxDelay: 1000, maxRetry: 0 },
  });

  await client.connect(endpointUrl(config));
  const session = await client.createSession();
  return { client, session };
}

export async function disconnectOpcua({ client, session }) {
  try {
    await session.close();
  } finally {
    await client.disconnect();
  }
}

export async function testOpcuaConnection(config) {
  const connection = await connectOpcua(config);
  await disconnectOpcua(connection);
}

export async function browseOpcuaNodes(config, nodeId = "RootFolder") {
  const connection = await connectOpcua(config);

  try {
    const result = await connection.session.browse(nodeId);
    return (result.references ?? []).map((reference) => ({
      nodeId: reference.nodeId.toString(),
      browseName: reference.browseName.name ?? reference.browseName.toString(),
      displayName: reference.displayName.text ?? reference.browseName.toString(),
      nodeClass: NodeClass[reference.nodeClass] ?? String(reference.nodeClass),
      selectable: reference.nodeClass === NodeClass.Variable,
    }));
  } finally {
    await disconnectOpcua(connection);
  }
}
