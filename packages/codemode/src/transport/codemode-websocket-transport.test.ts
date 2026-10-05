import { afterAll, afterEach, beforeAll, expect, test, assert } from "vitest";

import { once } from "node:events";

import { RpcSession, RpcTarget, type RpcStub } from "capnweb";
import WebSocket, { WebSocketServer } from "ws";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { CODEMODE_RPC_OPTIONS, CodemodeWebSocketTransport } from "./codemode-websocket-transport";

let server: WebSocketServer;
let url: string;
const sockets = new Set<WebSocket>();
beforeAll(async () => {
  server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: CODEMODE_LIMITS.maxFrameBytes,
  });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP listener");
  }
  url = `ws://127.0.0.1:${address.port}`;
});
afterEach(() => {
  for (const socket of sockets) {
    socket.terminate();
  }
  sockets.clear();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
async function connectCodemodeSockets() {
  const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const client = new WebSocket(url);
  await once(client, "open");
  const peer = await connected;
  sockets.add(client);
  sockets.add(peer);
  return { client, peer };
}

test("binary frames abort a pending receive and close the socket", async () => {
  const { client, peer } = await connectCodemodeSockets();
  const errors: Error[] = [];
  const transport = new CodemodeWebSocketTransport(
    client,
    () => client.bufferedAmount,
    (error) => errors.push(error),
    () => 0,
  );
  const received = expect(transport.receive()).rejects.toThrow("CODEMODE_TEXT_FRAME_REQUIRED");
  peer.send(new Uint8Array([1, 2, 3]));
  await received;
  expect(errors.map((error) => error.message)).toEqual(["CODEMODE_TEXT_FRAME_REQUIRED"]);
  assert(transport.closed);
});

test("an undrained reader cannot accumulate an unbounded receive queue", async () => {
  const { client, peer } = await connectCodemodeSockets();
  const errors: Error[] = [];
  const transport = new CodemodeWebSocketTransport(
    client,
    () => client.bufferedAmount,
    (error) => errors.push(error),
    () => 0,
  );
  const frame = "x".repeat(CODEMODE_LIMITS.maxFrameBytes);
  for (let count = 0; count < 3; count++) {
    peer.send(frame);
  }
  await expect.poll(() => transport.closed).toBe(true);
  await expect(transport.receive()).rejects.toThrow("CODEMODE_READ_QUEUE_LIMIT_EXCEEDED");
  expect(errors).toHaveLength(1);
});

test("oversized outbound frames fail before being sent", async () => {
  const { client } = await connectCodemodeSockets();
  const transport = new CodemodeWebSocketTransport(
    client,
    () => client.bufferedAmount,
    () => {},
    () => 0,
  );
  expect(() => transport.send("x".repeat(CODEMODE_LIMITS.maxFrameBytes + 1))).toThrow(
    "CODEMODE_FRAME_LIMIT_EXCEEDED",
  );
  expect(transport.metrics).toEqual({ messages: 0, bytes: 0 });
});

test("RPC errors do not export private causes, stacks, or enumerable credentials", async () => {
  const { client, peer } = await connectCodemodeSockets();
  class FailureTarget extends RpcTarget {
    async fail(): Promise<void> {
      const error = new Error("public failure", { cause: new Error("private cause") });
      error.name = "InternalError";
      error.stack = "private stack marker";
      Object.defineProperty(error, "apiKey", { value: "private credential", enumerable: true });
      throw error;
    }
  }
  const serverTransport = new CodemodeWebSocketTransport(
    peer,
    () => peer.bufferedAmount,
    () => {},
    () => 0,
  );
  new RpcSession(serverTransport, new FailureTarget(), CODEMODE_RPC_OPTIONS);
  const clientTransport = new CodemodeWebSocketTransport(
    client,
    () => client.bufferedAmount,
    () => {},
    () => 0,
  );
  const session = new RpcSession<FailureTarget>(clientTransport, undefined, CODEMODE_RPC_OPTIONS);
  const service = session.getRemoteMain();
  try {
    const error = await service.fail().catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "public failure" });
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("apiKey");
    assert(error instanceof Error);
    expect(error.stack ?? "").not.toContain("private stack marker");
  } finally {
    service[Symbol.dispose]();
  }
});

test("Cap'n Web reference tables are bounded even when a peer retains every returned capability", async () => {
  const { client, peer } = await connectCodemodeSockets();
  class CapabilityTarget extends RpcTarget {}
  class FactoryTarget extends RpcTarget {
    create() {
      return new CapabilityTarget();
    }
  }
  let serverSession: RpcSession | null = null;
  const errors: Error[] = [];
  const transport = new CodemodeWebSocketTransport(
    peer,
    () => peer.bufferedAmount,
    (error) => errors.push(error),
    () => {
      if (!serverSession) {
        return 0;
      }
      const { imports, exports } = serverSession.getStats();
      return imports + exports;
    },
  );
  serverSession = new RpcSession(transport, new FactoryTarget(), CODEMODE_RPC_OPTIONS);
  const clientTransport = new CodemodeWebSocketTransport(
    client,
    () => client.bufferedAmount,
    () => {},
    () => 0,
  );
  const session = new RpcSession<FactoryTarget>(clientTransport, undefined, CODEMODE_RPC_OPTIONS);
  const factory = session.getRemoteMain();
  const retained: RpcStub<CapabilityTarget>[] = [];
  try {
    await expect(
      (async () => {
        for (let count = 0; count <= CODEMODE_LIMITS.maxRpcReferences; count++) {
          retained.push(await factory.create());
        }
      })(),
    ).rejects.toThrow();
    expect(errors.map((error) => error.message)).toEqual(["CODEMODE_RPC_REFERENCE_LIMIT_EXCEEDED"]);
    expect(retained.length).toBeGreaterThan(0);
  } finally {
    for (const capability of retained) {
      capability[Symbol.dispose]();
    }
    factory[Symbol.dispose]();
  }
});
