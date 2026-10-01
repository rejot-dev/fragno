import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { once } from "node:events";

import { WebSocketServer, type WebSocket, type RawData } from "ws";

import { createCodemodeNodeExecutor } from "./codemode-node-client";
import { codemodeMessageSchema } from "./codemode-protocol";
import { decodeCodemodeFrame, encodeCodemodeFrame } from "./codemode-values";

let server: WebSocketServer;
let url: string;

beforeAll(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/v1/codemode/execute" });
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.each([true, false])(
  "successful completion closes normally when bridge initiates close: %s",
  async (bridgeInitiatesClose) => {
    const connection = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
    const execution = createCodemodeNodeExecutor({ url, apiKey: "local-test-key" })(
      {
        kind: "immediate",
        code: "() => 42",
        dependencies: {},
        providers: [],
        timeoutMs: 10_000,
      },
      {
        async handle() {
          throw new Error("Unexpected host operation");
        },
        close() {},
        async settle() {
          return null;
        },
      },
    );
    const socket = await connection;
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    const data = await new Promise<RawData>((resolve) => socket.once("message", resolve));
    const start = codemodeMessageSchema.parse(decodeCodemodeFrame(data.toString()));
    assert(start.type === "start");

    socket.send(
      encodeCodemodeFrame({
        type: "complete",
        completion: { status: "completed", value: 42, logs: [], workflowDefinition: null },
      }),
    );
    if (bridgeInitiatesClose) {
      socket.close(1000, "Codemode activation ended");
    }

    await expect(execution).resolves.toMatchObject({ status: "completed", value: 42 });
    const code = await closed;
    assert(code === 1000, `Expected normal WebSocket closure (1000), received ${code}`);
  },
);
