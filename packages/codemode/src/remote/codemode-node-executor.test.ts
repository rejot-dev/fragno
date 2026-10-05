import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { once } from "node:events";

import { RpcSession, RpcTarget } from "capnweb";
import { WebSocketServer, type WebSocket } from "ws";

import {
  CODEMODE_EXECUTION_HTTP_PATH,
  type CodemodeExecutionCapability,
} from "../execution/codemode-activation-contract";
import { createCodemodeHost } from "../host/codemode-host-capabilities";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";
import { createCodemodeNodeExecutor } from "./codemode-node-executor";

let server: WebSocketServer;
let url: string;
beforeAll(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: CODEMODE_EXECUTION_HTTP_PATH });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Codemode test server requires a TCP address.");
  }
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
test.each([true, false])(
  "successful completion closes normally when bridge initiates close: %s",
  async (bridgeInitiatesClose) => {
    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const execution = createCodemodeNodeExecutor({ url, apiKey: "local-test-key" })(
      { kind: "immediate", code: "() => 42", dependencies: {}, providers: [], timeoutMs: 10_000 },
      createCodemodeHost([], null),
    );
    const socket = await connection;
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    let session: RpcSession;
    class ExecutionTarget extends RpcTarget implements CodemodeExecutionCapability {
      async execute(request: Parameters<CodemodeExecutionCapability["execute"]>[0]) {
        assert(request.protocolVersion === 2);
        if (bridgeInitiatesClose) {
          setImmediate(() => {
            void session.drain().then(() => socket.close(1000, "Codemode activation ended"));
          });
        }
        return { status: "completed" as const, value: 42, logs: [], workflowDefinition: null };
      }
    }
    const transport = new CodemodeWebSocketTransport(
      socket,
      () => socket.bufferedAmount,
      () => {},
      () => 0,
    );
    session = new RpcSession(transport, new ExecutionTarget(), CODEMODE_RPC_OPTIONS);
    await expect(execution).resolves.toMatchObject({ status: "completed", value: 42 });
    const code = await closed;
    assert(code === 1000, `Expected normal WebSocket closure (1000), received ${code}`);
  },
);
