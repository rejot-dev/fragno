import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { once } from "node:events";

import { RpcSession, RpcTarget } from "capnweb";
import { WebSocketServer, type WebSocket } from "ws";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  CODEMODE_EXECUTION_HTTP_PATH,
  type CodemodeExecutionCapability,
} from "../execution/codemode-activation-contract";
import { codemodeWorkerBundleSchema } from "../execution/codemode-worker-bundle";
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
test.each([
  {
    name: "raw bundle exceeding a frame",
    source: "//" + "a".repeat(CODEMODE_LIMITS.maxFrameBytes),
  },
  {
    name: "escaped bundle exceeding a frame",
    source: "/*" + "\\".repeat(CODEMODE_LIMITS.maxFrameBytes / 2) + "*/",
  },
])("rejects a $name before opening a connection", async ({ source }) => {
  const bundle = codemodeWorkerBundleSchema.parse({
    mainModule: "script.js",
    modules: { "script.js": source },
    runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_compat"] },
  });
  let connections = 0;
  function onConnection() {
    connections++;
  }
  server.on("connection", onConnection);
  try {
    await expect(
      createCodemodeNodeExecutor({ url, apiKey: "local-test-key" })(
        {
          kind: "compiled",
          bundle,
          invocation: null,
          input: null,
          providers: [],
          timeoutMs: 10_000,
        },
        createCodemodeHost([], null),
      ),
    ).rejects.toThrow("CODEMODE_REMOTE_PAYLOAD_LIMIT_EXCEEDED");
    assert.equal(connections, 0);
  } finally {
    server.off("connection", onConnection);
  }
});

test("reserves Node capacity before preflight and releases failed preflight reservations", async () => {
  const execute = createCodemodeNodeExecutor({ url, apiKey: "local-test-key" });
  const invalid = {
    kind: "compiled" as const,
    bundle: {
      mainModule: "missing.js",
      modules: {},
      runtime: { compatibilityDate: "2026-05-07", compatibilityFlags: ["nodejs_compat"] },
    },
    invocation: null,
    input: null,
    providers: [],
    timeoutMs: 10_000,
  };
  for (let attempt = 0; attempt <= CODEMODE_LIMITS.maxNodeActivations; attempt++) {
    await expect(execute(invalid, createCodemodeHost([], null))).rejects.toThrow(
      "CODEMODE_BUNDLE_MAIN_MODULE_MISSING",
    );
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const transports: CodemodeWebSocketTransport[] = [];
  function accept(socket: WebSocket) {
    class ExecutionTarget extends RpcTarget implements CodemodeExecutionCapability {
      async execute() {
        started++;
        await gate;
        return { status: "completed" as const, value: 42, logs: [], workflowDefinition: null };
      }
    }
    const transport = new CodemodeWebSocketTransport(
      socket,
      () => socket.bufferedAmount,
      () => {},
      () => 0,
    );
    transports.push(transport);
    new RpcSession(transport, new ExecutionTarget(), CODEMODE_RPC_OPTIONS);
  }
  server.on("connection", accept);
  const running = Array.from({ length: CODEMODE_LIMITS.maxNodeActivations }, () =>
    execute(
      { kind: "immediate", code: "() => 42", dependencies: {}, providers: [], timeoutMs: 10_000 },
      createCodemodeHost([], null),
    ),
  );
  const settled = Promise.allSettled(running);
  let preflightReads = 0;
  try {
    await expect.poll(() => started).toBe(CODEMODE_LIMITS.maxNodeActivations);
    const oversized = {
      ...invalid,
      get bundle() {
        preflightReads++;
        return {
          ...invalid.bundle,
          mainModule: "script.js",
          modules: { "script.js": "a".repeat(CODEMODE_LIMITS.maxFrameBytes) },
        };
      },
    };
    await expect(execute(oversized, createCodemodeHost([], null))).rejects.toThrow(
      "CODEMODE_NODE_ACTIVATION_LIMIT_EXCEEDED",
    );
    expect(preflightReads).toBe(0);
  } finally {
    release();
    await settled;
    server.off("connection", accept);
    for (const transport of transports) {
      transport.abort(new Error("Test finished"));
    }
  }
  expect(await settled).toHaveLength(CODEMODE_LIMITS.maxNodeActivations);
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
