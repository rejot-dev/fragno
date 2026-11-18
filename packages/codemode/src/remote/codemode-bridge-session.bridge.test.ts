import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { once } from "node:events";

import { NonRetryableError, WaitForEventTimeoutError } from "@fragno-dev/workflows/workflow";
import { RpcSession } from "capnweb";
import WebSocket from "ws";
import { z } from "zod";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  CODEMODE_EXECUTION_HTTP_PATH,
  type CodemodeExecutionCapability,
  type CodemodeExecutor,
  type CodemodeWorkflowHost,
  type CodemodeWorkflowTransactionHost,
} from "../execution/codemode-activation-contract";
import { codemodeWorkerBundleSchema } from "../execution/codemode-worker-bundle";
import { createCodemodeHost } from "../host/codemode-host-capabilities";
import { createCodemodeTestServer } from "../testing/codemode-test-server";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";
import { createCodemodeNodeExecutor } from "./codemode-node-executor";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
let execute: CodemodeExecutor;
beforeAll(async () => {
  server = await createCodemodeTestServer();
  execute = createCodemodeNodeExecutor(server);
});
afterAll(async () => {
  await server?.close();
});

function providerHost(workflow: CodemodeWorkflowHost | null = null, writes: unknown[] = []) {
  return {
    writes,
    ...createCodemodeHost(
      [
        {
          name: "store",
          fns: {
            write: async (value) => {
              writes.push(value);
              return value;
            },
          },
        },
      ],
      workflow,
    ),
  };
}
function workflowHost(
  overrides: Partial<CodemodeWorkflowHost> = {},
  emitted: unknown[] = [],
  onEvent: CodemodeWorkflowTransactionHost["onEvent"] = () => {
    throw new Error("No event source configured");
  },
) {
  const transaction: CodemodeWorkflowTransactionHost = {
    emit(payload) {
      emitted.push(payload);
    },
    async previousEmissions() {
      return [...emitted];
    },
    async previousConsumedEvents() {
      return [];
    },
    workflowServiceCalls() {},
    triggerHook() {},
    onEvent,
  };
  const workflow: CodemodeWorkflowHost = {
    async do(_name, _config, callback) {
      return { type: "settled", ok: true, value: await callback(transaction), order: null };
    },
    async sleep() {
      throw new Error("Unexpected sleep");
    },
    async sleepUntil() {
      throw new Error("Unexpected sleepUntil");
    },
    async waitForEvent() {
      throw new Error("Unexpected waitForEvent");
    },
    ...overrides,
  };
  return workflow;
}
const base = {
  dependencies: {},
  modules: {},
  timeoutMs: 10_000,
  providers: [{ name: "store", tools: ["write"] }],
};
/** Saved programs compile at their own path; inline code has none. */
function program(kind: "immediate" | "module", code: string, modules: Record<string, string> = {}) {
  return kind === "module"
    ? { ...base, kind, entry: "/script.js", modules: { ...modules, "/script.js": code } }
    : { ...base, kind, code, modules };
}
function moduleBuild(code: string) {
  return {
    kind: "module-build" as const,
    dependencies: {},
    entry: "/script.js",
    modules: { "/script.js": code },
  };
}
const workflowBase = {
  ...base,
  kind: "workflow" as const,
  event: {
    id: "event",
    instanceId: "instance",
    timestamp: new Date("2026-09-29T00:00:00Z"),
    payload: {},
  },
  settledOrders: [],
};
/** A workflow program is a module that exports its definition by default. */
function workflow(run: string) {
  return {
    ...workflowBase,
    entry: "/workflow.js",
    modules: { "/workflow.js": `export default defineWorkflow({ name: "test" }, ${run});` },
  };
}

test("generic module bundles accept consumer invocations with fresh inputs and providers when compilation is unavailable", async () => {
  let available = true;
  let compilations = 0;
  const buildServer = await createCodemodeTestServer((compile) => async (input) => {
    compilations += 1;
    if (!available) {
      throw new Error("Compiler unavailable");
    }
    return await compile(input);
  });
  const run = createCodemodeNodeExecutor(buildServer);
  const buildHost = providerHost();
  try {
    const built = await run(
      moduleBuild(
        "let calls = 0; export const double = value => value * 2; export default value => `${value}:${calls++}`;",
      ),
      buildHost,
    );
    assert(built.status === "completed");
    const { bundle } = z.object({ bundle: codemodeWorkerBundleSchema }).parse(built.value);
    expect(buildHost.writes).toEqual([]);
    expect(compilations).toBe(1);
    available = false;
    for (const value of ["first", "second"]) {
      const host = providerHost();
      const output = await run(
        {
          kind: "compiled",
          bundle,
          invocation: "async (module, input) => await store.write(module.default(input.value))",
          input: { value },
          providers: base.providers,
          timeoutMs: 10_000,
        },
        host,
      );
      expect(output).toMatchObject({ status: "completed", value: `${value}:0` });
      expect(host.writes).toEqual([`${value}:0`]);
    }
    expect(compilations).toBe(1);
    expect(
      await run(
        {
          kind: "compiled",
          bundle,
          invocation: "(module, input) => module.double(input)",
          input: 21,
          providers: [],
          timeoutMs: 10_000,
        },
        createCodemodeHost([], null),
      ),
    ).toMatchObject({ status: "completed", value: 42 });
    const conflictingBundle = {
      ...bundle,
      modules: {
        ...bundle.modules,
        "__fragno_module_invocation__.js": 'throw new Error("Unlisted module must not execute");',
      },
    };
    expect(
      await run(
        {
          kind: "compiled",
          bundle: conflictingBundle,
          invocation: "module => module.double(5)",
          input: null,
          providers: [],
          timeoutMs: 10_000,
        },
        createCodemodeHost([], null),
      ),
    ).toMatchObject({ status: "completed", value: 10 });
    expect(compilations).toBe(1);
  } finally {
    await buildHost.close();
    await buildServer.close();
  }
});

test("oversized module-build results return a failed completion without breaking the RPC session", async () => {
  let oversized = true;
  const buildServer = await createCodemodeTestServer((compile) => async (input) => {
    const compiled = await compile(input);
    if (!oversized) {
      return compiled;
    }
    return {
      ...compiled,
      bundle: {
        ...compiled.bundle,
        modules: {
          ...compiled.bundle.modules,
          [compiled.bundle.mainModule]:
            compiled.bundle.modules[compiled.bundle.mainModule] +
            "\n/*" +
            "a".repeat(CODEMODE_LIMITS.maxFrameBytes) +
            "*/",
        },
      },
    };
  });
  const build = createCodemodeNodeExecutor(buildServer);
  try {
    const result = await build(moduleBuild("export default 42;"), createCodemodeHost([], null));
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.stringContaining("CODEMODE_REMOTE_PAYLOAD_LIMIT_EXCEEDED") },
    });
    oversized = false;
    expect(
      await build(moduleBuild("export default 42;"), createCodemodeHost([], null)),
    ).toMatchObject({ status: "completed" });
  } finally {
    await buildServer.close();
  }
});

test("precompiled guests cannot bypass their host-owned wall deadline", async () => {
  const host = createCodemodeHost([], null);
  try {
    const built = await execute(moduleBuild("export default () => new Promise(() => {});"), host);
    assert(built.status === "completed");
    const { bundle } = z.object({ bundle: codemodeWorkerBundleSchema }).parse(built.value);
    await expect(
      execute(
        {
          kind: "compiled",
          bundle,
          invocation: "module => module.default()",
          input: null,
          providers: [],
          timeoutMs: 100,
        },
        createCodemodeHost([], null),
      ),
      // A deadline is the guest's own outcome; only a lost bridge reaches Node as an interruption.
    ).resolves.toMatchObject({
      status: "failed",
      error: { kind: "interrupted", message: "CODEMODE_ACTIVATION_TIMED_OUT" },
    });
  } finally {
    await host.close();
  }
});

test("the bridge fails mismatched application versions and accepts only one execution per socket", async () => {
  let compilations = 0;
  const versionServer = await createCodemodeTestServer((compile) => async (input) => {
    compilations += 1;
    return await compile(input);
  });
  const url = new URL(CODEMODE_EXECUTION_HTTP_PATH, versionServer.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url.href, {
    headers: { Authorization: `Bearer ${versionServer.apiKey}` },
  });
  const host = createCodemodeHost([], null);
  try {
    await once(socket, "open");
    const transport = new CodemodeWebSocketTransport(
      socket,
      () => socket.bufferedAmount,
      () => void host.close(),
      () => 0,
    );
    const session = new RpcSession<CodemodeExecutionCapability>(
      transport,
      undefined,
      CODEMODE_RPC_OPTIONS,
    );
    const bridge = session.getRemoteMain();
    const request = {
      protocolVersion: 2 as const,
      executionId: crypto.randomUUID(),
      activation: { ...base, kind: "immediate" as const, providers: [], code: "42" },
    };
    try {
      // Node reads any rejection as a lost session, so contract failures are answered instead.
      await expect(
        bridge.execute({ ...request, protocolVersion: 1 } as never, host.capabilities),
      ).resolves.toMatchObject({ status: "failed", error: { name: "ZodError" } });
      expect(compilations).toEqual(0);
      await expect(bridge.execute(request, host.capabilities)).resolves.toMatchObject({
        status: "completed",
        value: 42,
      });
      await expect(bridge.execute(request, host.capabilities)).resolves.toMatchObject({
        status: "failed",
        error: { message: "CODEMODE_INVALID_START" },
      });
      assert(compilations === 1);
    } finally {
      bridge[Symbol.dispose]();
    }
  } finally {
    await host.close();
    socket.terminate();
    await versionServer.close();
  }
});

test("ordinary Worker executes source and calls Node without a Durable Object", async () => {
  const host = providerHost();
  const completion = await execute(
    {
      ...base,
      kind: "immediate",
      code: 'async () => { console.log("guest log"); return await store.write({ saved: true }); }',
    },
    host,
  );
  expect(completion).toEqual({
    status: "completed",
    value: { saved: true },
    logs: [{ at: expect.any(Number), channel: "log", text: "guest log" }],
    workflowDefinition: null,
  });
  expect(host.writes).toEqual([{ saved: true }]);
});

test("guest console calls are stored per channel with the guest's clock", async () => {
  const completion = await execute(
    {
      ...base,
      kind: "immediate",
      code: `async () => {
        console.log("plain", 1);
        console.info("info");
        console.debug("debug");
        console.warn("warn");
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.error("error");
      }`,
    },
    providerHost(),
  );
  assert(completion.status === "completed");
  expect(completion.logs.map(({ channel, text }) => [channel, text])).toEqual([
    ["log", "plain 1"],
    ["info", "info"],
    ["debug", "debug"],
    ["warn", "warn"],
    ["error", "error"],
  ]);
  // Workers advance the clock only across I/O, so only the awaited timer separates timestamps.
  const [first, , , beforeTimer, afterTimer] = completion.logs.map((line) => line.at);
  assert(first === beforeTimer && afterTimer > beforeTimer);
});

test("tool values survive native RPC and Cap'n Web without nested JSON codecs", async () => {
  const host = providerHost();
  const completion = await execute(
    {
      ...base,
      kind: "immediate",
      code: `async () => {
    const value = await store.write({ date: new Date("2026-10-05"), bigint: 123n, missing: undefined, nan: NaN, bytes: new Uint16Array([256, 65535]), buffer: new Uint8Array([1, 2]).buffer, tag: { __codemode_binary_v1__: "Uint8Array", data: "not encoded" } });
    return { ...value, typed: value.bytes instanceof Uint16Array, buffered: value.buffer instanceof ArrayBuffer };
  }`,
    },
    host,
  );
  expect(completion).toMatchObject({
    status: "completed",
    value: {
      date: new Date("2026-10-05"),
      bigint: 123n,
      missing: undefined,
      nan: NaN,
      bytes: new Uint16Array([256, 65535]),
      buffer: new Uint8Array([1, 2]).buffer,
      typed: true,
      buffered: true,
      tag: { __codemode_binary_v1__: "Uint8Array", data: "not encoded" },
    },
  });
  expect(host.writes).toHaveLength(1);
});

test("module activation imports the file without invoking its default export", async () => {
  const host = providerHost();
  const completion = await execute(
    program(
      "module",
      'await store.write("module body"); export default () => store.write("wrong");',
    ),
    host,
  );
  expect(completion.status, JSON.stringify(completion)).toBe("completed");
  expect(host.writes).toEqual(["module body"]);
});

test.each([
  {
    kind: "immediate" as const,
    code: 'async () => { const { save } = await import("/lib/save.js"); return await save("immediate"); }',
  },
  {
    kind: "module" as const,
    code: 'import { save } from "/lib/save.js"; await save("module");',
  },
])(
  "$kind source imports source modules that reach providers through globals",
  async ({ kind, code }) => {
    const host = providerHost();
    const completion = await execute(
      program(kind, code, {
        "/lib/save.js":
          'import { tag } from "./tag.js"; export const save = (value) => store.write(tag(value));',
        "/lib/tag.js": "export const tag = (value) => `saved:${value}`;",
      }),
      host,
    );
    expect(completion.status, JSON.stringify(completion)).toBe("completed");
    expect(host.writes).toEqual([`saved:${kind}`]);
  },
);

test.each([
  { kind: "immediate" as const, code: '() => { throw "boom"; }' },
  { kind: "module" as const, code: 'throw "boom";' },
])("$kind source reports primitive throws as failures", async ({ kind, code }) => {
  expect(await execute(program(kind, code), providerHost())).toMatchObject({
    status: "failed",
    error: { message: "boom" },
  });
});
test("object throws preserve string message properties", async () => {
  expect(
    await execute(
      { ...base, kind: "immediate", code: '() => { throw { message: "object boom" }; }' },
      providerHost(),
    ),
  ).toMatchObject({ status: "failed", error: { message: "object boom" } });
});
test.each([
  { label: "empty string", code: '() => { throw ""; }' },
  { label: "empty Error message", code: "() => { throw new Error(); }" },
])("$label throws use a non-empty execution failure", async ({ code }) => {
  expect(await execute({ ...base, kind: "immediate", code }, providerHost())).toMatchObject({
    status: "failed",
    error: { message: "CODEMODE_EXECUTION_FAILED" },
  });
});
test.each(["immediate", "module"] as const)(
  "%s source preserves the configured evaluation timeout",
  async (kind) => {
    expect(
      await execute(
        {
          ...program(
            kind,
            kind === "module"
              ? "await new Promise(() => {});"
              : "async () => await new Promise(() => {})",
          ),
          timeoutMs: 50,
        },
        providerHost(),
      ),
    ).toMatchObject({ status: "failed", error: { message: "Execution timed out" } });
  },
);
test("guest cannot fetch or inspect host credentials", async () => {
  expect(
    await execute(
      {
        ...base,
        kind: "immediate",
        code: 'async () => { try { await fetch("https://example.com"); } catch { return { denied: true, credential: globalThis.SANDBOX_API_KEY }; } }',
      },
      providerHost(),
    ),
  ).toMatchObject({ status: "completed", value: { denied: true, credential: undefined } });
});
test("unauthorized clients never execute a provider operation", async () => {
  const host = providerHost();
  await expect(
    createCodemodeNodeExecutor({ ...server, apiKey: "incorrect" })(
      { ...base, kind: "immediate", code: '() => store.write("wrong")' },
      host,
    ),
  ).rejects.toThrow("HTTP 401");
  expect(host.writes).toEqual([]);
});
test.each(["immediate", "workflow"] as const)(
  "$kind activation cannot invoke host tools outside its advertised allowlist",
  async (kind) => {
    const writes: unknown[] = [];
    let secretCalls = 0;
    const host = createCodemodeHost(
      [
        {
          name: "store",
          fns: {
            "allowed-tool": async (value) => {
              writes.push(value);
              return value;
            },
            secret: async () => {
              secretCalls += 1;
              return "private";
            },
          },
        },
      ],
      kind === "workflow" ? workflowHost() : null,
    );
    const callback = `async () => {
      const allowed = await store.allowed_tool({ saved: true });
      const denied = [];
      for (const tool of ["secret", "allowed-tool", "allowed tool", "Allowed_tool", "missing"]) {
        try { await store[tool]("wrong"); }
        catch (error) { denied.push(error.message); }
      }
      return { allowed, denied };
    }`;
    const providers = [{ name: "store", tools: ["allowed_tool", "missing"] }];
    const completion = await execute(
      kind === "workflow"
        ? {
            ...workflow(`async (_event, step) => await step.do("restricted", ${callback})`),
            providers,
          }
        : { ...base, kind, providers, code: callback },
      host,
    );
    expect(completion).toMatchObject({
      status: "completed",
      value: {
        allowed: { saved: true },
        denied: [
          "Unknown tool: secret",
          "Unknown tool: allowed-tool",
          "Unknown tool: allowed tool",
          "Unknown tool: Allowed_tool",
          "Unknown tool: missing",
        ],
      },
    });
    expect(writes).toEqual([{ saved: true }]);
    expect(secretCalls).toBe(0);
  },
);

test.each(["immediate", "workflow"] as const)(
  "$kind activation with an empty tool allowlist cannot invoke a registered host tool",
  async (kind) => {
    const host = providerHost(kind === "workflow" ? workflowHost() : null);
    const providers = [{ name: "store", tools: [] }];
    const completion = await execute(
      kind === "workflow"
        ? {
            ...workflow(
              'async (_event, step) => await step.do("restricted", async () => await store.write("wrong"))',
            ),
            providers,
          }
        : { ...base, kind, providers, code: 'async () => await store.write("wrong")' },
      host,
    );
    expect(completion).toMatchObject({
      status: "failed",
      error: { message: "Unknown tool: write" },
    });
    expect(host.writes).toEqual([]);
  },
);

test("unregistered tools cannot gain authority through remote property lookup", async () => {
  const host = providerHost();
  expect(
    await execute(
      {
        ...base,
        kind: "immediate",
        providers: [{ name: "store", tools: ["write", "constructor"] }],
        code: "async () => await store.constructor()",
      },
      host,
    ),
  ).toMatchObject({ status: "failed", error: { message: "Unknown tool: constructor" } });
  expect(host.writes).toEqual([]);
});
test("a step.do callback that calls another step fails without retries", async () => {
  let callbackError: unknown;
  const source = workflowHost();
  const host = providerHost(
    workflowHost({
      async do(name, config, callback) {
        try {
          return await source.do(name, config, callback);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
    }),
  );
  await execute(
    {
      ...workflow(
        'async (_event, step) => await step.do("outer", async () => await step.do("inner", async () => "inner"))',
      ),
    },
    host,
  );
  expect(callbackError).toBeInstanceOf(NonRetryableError);
  expect(callbackError).toMatchObject({
    message: expect.stringContaining(
      'WORKFLOW_STEP_NESTED_IN_DO: step "inner" was called inside step "outer"',
    ),
  });
});
test("an onConsume callback that calls another step fails", async () => {
  const steps: string[] = [];
  const source = workflowHost();
  let consumeError: unknown;
  const host = providerHost(
    workflowHost({
      async do(name, config, callback) {
        steps.push(name);
        return await source.do(name, config, callback);
      },
      async waitForEvent(_name, options) {
        const event = { type: options.type, payload: {}, timestamp: new Date() };
        try {
          await options.onConsume?.({} as CodemodeWorkflowTransactionHost, event);
        } catch (error) {
          consumeError = error;
        }
        return { type: "settled", ok: true, value: event, order: null };
      },
    }),
  );
  await execute(
    workflow(`async (_event, step) => await step.waitForEvent("ready", {
    type: "ready",
    onConsume: async () => { await step.do("child", () => "child"); },
  })`),
    host,
  );
  expect(steps).toEqual([]);
  expect(consumeError).toBeInstanceOf(NonRetryableError);
  expect(consumeError).toMatchObject({
    message: expect.stringContaining(
      'WORKFLOW_STEP_NESTED_IN_DO: step "child" was called inside step "ready"',
    ),
  });
});
test("a tx.onEvent handler that calls another step fails", async () => {
  const steps: string[] = [];
  const listeners = new Set<Parameters<CodemodeWorkflowTransactionHost["onEvent"]>[1]>();
  const source = workflowHost({}, [], (_type, callback) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  });
  const host = providerHost(
    workflowHost({
      async do(name, config, callback) {
        steps.push(name);
        return await source.do(name, config, callback);
      },
    }),
  );
  const execution = execute(
    workflow(`async (_event, step) => await step.do("listen", async (tx) => await new Promise((resolve) => {
    tx.onEvent("ready", async (event) => {
      try { await step.do("child", () => "child"); }
      catch (error) { resolve(error.message); }
    });
  }))`),
    host,
  );
  await expect.poll(() => listeners.size).toBe(1);
  await [...listeners][0]({
    id: "ready-1",
    type: "ready",
    timestamp: new Date(),
    payload: {},
    consume() {},
  });
  expect(await execution).toMatchObject({
    status: "completed",
    value: expect.stringContaining(
      'WORKFLOW_STEP_NESTED_IN_DO: step "child" was called inside step "listen"',
    ),
  });
  expect(steps).toEqual(["listen"]);
});
test("a workflow module statically imports a relative source module that reaches providers through globals", async () => {
  const host = providerHost(workflowHost());
  const completion = await execute(
    {
      ...workflowBase,
      entry: "/automations/save.workflow.js",
      modules: {
        "/lib/save.js": "export const save = (value) => store.write(value);",
        "/automations/save.workflow.js": [
          'import { save } from "../lib/save.js";',
          'export default defineWorkflow({ name: "save" }, async (_event, step) => await step.do("save", async () => await save("workflow")));',
        ].join("\n"),
      },
    },
    host,
  );
  expect(completion).toMatchObject({ status: "completed", value: "workflow" });
  expect(host.writes).toEqual(["workflow"]);
});
test.each(["logs", "suspensionKey", "RpcTarget"])(
  "workflow rejects generated binding provider name %s before compilation",
  async (name) => {
    expect(
      await execute(
        { ...workflow("async () => undefined"), providers: [{ name, tools: [] }] },
        providerHost(),
      ),
    ).toMatchObject({
      status: "failed",
      error: { message: `Provider name "${name}" is reserved` },
    });
  },
);
test("sleepUntil carries a Date to Node, and a parked step suspends the activation", async () => {
  const host = providerHost(
    workflowHost({
      async sleepUntil(_name, timestamp) {
        expect(timestamp).toEqual(workflowBase.event.timestamp);
        return { type: "parked" };
      },
    }),
  );
  expect(
    await execute(
      {
        ...workflow(
          'async (event, step) => { console.log("before sleep"); await step.sleepUntil("wait", event.timestamp); }',
        ),
      },
      host,
    ),
  ).toMatchObject({
    status: "suspended",
    logs: [{ channel: "log", text: "before sleep" }],
  });
});
test("transaction emissions flush before callback completion and retained transactions lose authority", async () => {
  const emitted: unknown[] = [];
  const host = providerHost(workflowHost({}, emitted));
  const completion = await execute(
    {
      ...workflow(`async (_event, step) => {
    let retained;
    const value = await step.do("emit", async (tx) => { retained = tx; tx.emit({ committed: true }); return 42; });
    try { await retained.previousEmissions(); return "must not work"; } catch { return value; }
  }`),
    },
    host,
  );
  expect(completion).toMatchObject({ status: "completed", value: 42 });
  expect(emitted).toEqual([{ committed: true }]);
});
test("subscriptions retain callbacks after registration and revoke them when the step ends", async () => {
  const listeners = new Set<Parameters<CodemodeWorkflowTransactionHost["onEvent"]>[1]>();
  const consumed: string[] = [];
  const host = providerHost(
    workflowHost({}, [], (_type, callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }),
  );
  const execution = execute(
    {
      ...workflow(`async (_event, step) => await step.do("listen", async (tx) => {
    const event = await new Promise((resolve) => { tx.onEvent("ready", async (event) => {
      await store.write(event.payload);
      event.consume();
      resolve(event.payload);
    }); });
    return event;
  })`),
    },
    host,
  );
  await expect.poll(() => listeners.size).toBe(1);
  const listener = [...listeners][0];
  await listener({
    id: "ready-1",
    type: "ready",
    timestamp: new Date(),
    payload: { value: 42 },
    consume() {
      consumed.push("ready-1");
    },
  });
  expect(await execution).toMatchObject({ status: "completed", value: { value: 42 } });
  expect(consumed).toEqual(["ready-1"]);
  assert(listeners.size === 0);
  await listener({
    id: "late",
    type: "ready",
    timestamp: new Date(),
    payload: "must not deliver",
    consume() {
      consumed.push("late");
    },
  });
  expect(host.writes).toEqual([{ value: 42 }]);
  expect(consumed).toEqual(["ready-1"]);
});

test("permanent callback errors retain their runner failure class on Node", async () => {
  let callbackError: unknown;
  const source = workflowHost();
  const host = providerHost(
    workflowHost({
      async do(name, config, callback) {
        try {
          return await source.do(name, config, callback);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
    }),
  );
  await execute(
    {
      ...workflow(
        'async (_event, step) => await step.do("fail", async () => { const error = new Error("permanent"); error.name = "NonRetryableError"; throw error; })',
      ),
    },
    host,
  );
  expect(callbackError).toBeInstanceOf(NonRetryableError);
});
test("guests can catch the domain class of host-issued event timeouts", async () => {
  const host = providerHost(
    workflowHost({
      async waitForEvent() {
        throw new WaitForEventTimeoutError();
      },
    }),
  );
  expect(
    await execute(
      {
        ...workflow(`async (_event, step) => {
    try { await step.waitForEvent("ready", { type: "ready" }); }
    catch (error) { return error.name; }
  }`),
      },
      host,
    ),
  ).toMatchObject({ status: "completed", value: "WaitForEventTimeoutError" });
});

test("a race hands back the step that settled first on the host, whenever its outcome arrives", async () => {
  const host = providerHost(
    workflowHost({
      async do(name, _config, callback) {
        const value = await callback({} as CodemodeWorkflowTransactionHost);
        if (name === "first") {
          // Settled first on the host, but its outcome reaches the guest last.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { type: "settled", ok: true, value, order: 0 };
        }
        return { type: "settled", ok: true, value, order: 1 };
      },
    }),
  );
  expect(
    await execute(
      workflow(
        'async (_event, step) => await Promise.race([step.do("first", () => "first"), step.do("second", () => "second")])',
      ),
      host,
    ),
  ).toMatchObject({ status: "completed", value: "first" });
});
test("a replayed race hands back its steps in their recorded order", async () => {
  const host = providerHost(
    workflowHost({
      async do(name) {
        // Both replay; "second" settled first when the race originally ran.
        return name === "second"
          ? { type: "settled", ok: true, value: "second", order: 3 }
          : { type: "settled", ok: true, value: "first", order: 4 };
      },
    }),
  );
  expect(
    await execute(
      {
        ...workflow(
          'async (_event, step) => await Promise.race([step.do("first", () => "first"), step.do("second", () => "second")])',
        ),
        settledOrders: [3, 4],
      },
      host,
    ),
  ).toMatchObject({ status: "completed", value: "second" });
});
test("steps beside a parked step finish before the activation suspends", async () => {
  const host = providerHost(
    workflowHost({
      async sleep() {
        return { type: "parked" };
      },
    }),
  );
  expect(
    await execute(
      workflow(`async (_event, step) => await Promise.all([
    step.sleep("wait", "1 hour"),
    step.do("beside", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return await store.write("beside");
    }),
  ])`),
      host,
    ),
  ).toMatchObject({ status: "suspended" });
  expect(host.writes).toEqual(["beside"]);
});
test("a workflow tick the bridge ends at its deadline is interrupted, unlike a guest's own interruption error", async () => {
  expect(
    await execute(
      {
        ...workflow('async (_event, step) => await step.do("hang", () => new Promise(() => {}))'),
        timeoutMs: 500,
      },
      providerHost(workflowHost()),
    ),
  ).toEqual({ status: "interrupted", cause: "CODEMODE_ACTIVATION_TIMED_OUT" });
  expect(
    await execute(
      workflow(
        'async () => { const error = new Error("CODEMODE_ACTIVATION_TIMED_OUT"); error.name = "CodemodeInterruptedError"; throw error; }',
      ),
      providerHost(workflowHost()),
    ),
  ).toMatchObject({ status: "failed" });
});
test("a guest cannot catch a step call its host broke off", async () => {
  const host = providerHost(workflowHost());
  const stepTarget = host.capabilities.stepTarget;
  assert(stepTarget);
  const brokenHost = {
    ...host,
    capabilities: {
      ...host.capabilities,
      stepTarget: {
        ...stepTarget,
        do: async () => {
          throw new Error("HOST_LOST");
        },
      },
    },
  };
  expect(
    await execute(
      workflow(`async (_event, step) => {
    try { return await step.do("charge", () => "charged"); }
    catch { return "not charged"; }
  }`),
      brokenHost,
    ),
  ).toMatchObject({ status: "failed", error: { message: "HOST_LOST" } });
});

test.each(["resolve", "reject"] as const)(
  "timed-out activations hold compiler admission, so newcomers wait until stalled calls %s",
  async (settlement) => {
    let resumeCompilation!: () => void;
    const compilerGate = new Promise<void>((resolve) => {
      resumeCompilation = resolve;
    });
    let stalled = true;
    let compilationCount = 0;
    const limitedServer = await createCodemodeTestServer((compile) => async (input) => {
      compilationCount += 1;
      if (stalled) {
        await compilerGate;
        if (settlement === "reject") {
          throw new Error("Delayed compiler failure");
        }
      }
      return await compile(input);
    });
    const executeLimited = createCodemodeNodeExecutor(limitedServer);
    const writes: unknown[] = [];
    try {
      const activations = Promise.all(
        Array.from({ length: CODEMODE_LIMITS.maxBridgeCompilations }, () =>
          executeLimited(
            {
              ...workflow('async () => await store.write("must not execute after timeout")'),
              timeoutMs: 1_000,
            },
            providerHost(null, writes),
          ),
        ),
      );
      await expect.poll(() => compilationCount).toBe(CODEMODE_LIMITS.maxBridgeCompilations);
      // A workflow tick the bridge ends at its deadline has no outcome; its runner decides.
      for (const completion of await activations) {
        expect(completion).toEqual({
          status: "interrupted",
          cause: "CODEMODE_ACTIVATION_TIMED_OUT",
        });
      }
      const replacement = {
        ...base,
        kind: "immediate" as const,
        code: 'async () => await store.write("recovered")',
      };
      const recovered = executeLimited(replacement, providerHost(null, writes));
      // The newcomer queues behind compilations that the timed-out activations still hold.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(compilationCount).toBe(CODEMODE_LIMITS.maxBridgeCompilations);
      expect(writes).toEqual([]);
      stalled = false;
      resumeCompilation();
      expect(await recovered).toMatchObject({ status: "completed" });
      expect(writes).toEqual(["recovered"]);
    } finally {
      resumeCompilation();
      await limitedServer.close();
    }
  },
);

test.each(["immediate", "module", "workflow"] as const)(
  "%s completion budgets compiler warnings with a full guest log buffer",
  async (kind) => {
    const warningServer = await createCodemodeTestServer((compile) => async (input) => ({
      ...(await compile(input)),
      warnings: ["compiler warning"],
    }));
    try {
      const logSource = `for (let i = 0; i < ${CODEMODE_LIMITS.maxLogs}; i++) console.log("guest log");`;
      const code =
        kind === "module" ? logSource : `async (_event, _step) => { ${logSource} return 42; }`;
      const completion = await createCodemodeNodeExecutor(warningServer)(
        kind === "workflow" ? workflow(code) : program(kind, code),
        providerHost(),
      );
      assert(completion.status === "completed");
      expect(completion.logs).toHaveLength(CODEMODE_LIMITS.maxLogs);
      expect(completion.logs[0]).toMatchObject({ channel: "codemode", text: "compiler warning" });
      expect(completion.logs.at(-2)).toMatchObject({ channel: "log", text: "guest log" });
      expect(completion.logs.at(-1)).toMatchObject({
        channel: "codemode",
        text: "Logs truncated.",
      });
    } finally {
      await warningServer.close();
    }
  },
);
test.each(["completed", "failed", "suspended"] as const)(
  "%s completion budgets combined log bytes using UTF-8",
  async (status) => {
    const warning = "é".repeat(CODEMODE_LIMITS.maxLogBytes / 4);
    const warningServer = await createCodemodeTestServer((compile) => async (input) => ({
      ...(await compile(input)),
      warnings: [warning],
    }));
    try {
      const logSource = `console.log("🙂".repeat(${CODEMODE_LIMITS.maxLogBytes / 4}));`;
      const executeWarning = createCodemodeNodeExecutor(warningServer);
      const completion =
        status === "suspended"
          ? await executeWarning(
              {
                ...workflow(
                  `async (event, step) => { ${logSource} await step.sleepUntil("wait", event.timestamp); }`,
                ),
              },
              providerHost(
                workflowHost({
                  async sleepUntil() {
                    return { type: "parked" };
                  },
                }),
              ),
            )
          : await executeWarning(
              {
                ...base,
                kind: "immediate",
                code: `async () => { ${logSource} ${status === "failed" ? 'throw new Error("guest failure");' : "return 42;"} }`,
              },
              providerHost(),
            );
      expect(completion.status).toBe(status);
      assert(completion.status !== "interrupted");
      expect(completion.logs.map(({ channel, text }) => [channel, text])).toEqual([
        ["codemode", warning],
        ["codemode", "Logs truncated."],
      ]);
      const text = completion.logs.map((line) => line.text).join("");
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        CODEMODE_LIMITS.maxLogBytes,
      );
    } finally {
      await warningServer.close();
    }
  },
);
test.each([0, 1])(
  "compiler warnings at the byte limit plus %i bytes stay transport-safe",
  async (overflow) => {
    const warning = "x".repeat(CODEMODE_LIMITS.maxLogBytes + overflow);
    const warningServer = await createCodemodeTestServer((compile) => async (input) => ({
      ...(await compile(input)),
      warnings: [warning],
    }));
    try {
      const completion = await createCodemodeNodeExecutor(warningServer)(
        { ...base, kind: "immediate", code: "() => 42" },
        providerHost(),
      );
      assert(completion.status === "completed");
      assert.equal(completion.value, 42);
      expect(completion.logs.map((line) => line.text)).toEqual(
        overflow ? ["Logs truncated."] : [warning],
      );
    } finally {
      await warningServer.close();
    }
  },
);
test("a full compile queue declines newcomers, which the caller reads as interrupted", async () => {
  let resumeCompilation!: () => void;
  const compilerGate = new Promise<void>((resolve) => {
    resumeCompilation = resolve;
  });
  let compilations = 0;
  const limitedServer = await createCodemodeTestServer((compile) => async (input) => {
    compilations += 1;
    await compilerGate;
    return await compile(input);
  });
  const executeLimited = createCodemodeNodeExecutor(limitedServer);
  const activation = { ...base, kind: "immediate" as const, code: "() => 42" };
  try {
    const admitted = Array.from(
      {
        length: CODEMODE_LIMITS.maxBridgeCompilations + CODEMODE_LIMITS.maxQueuedBridgeCompilations,
      },
      () => executeLimited(activation, providerHost()),
    );
    await expect.poll(() => compilations).toBe(CODEMODE_LIMITS.maxBridgeCompilations);
    // The bridge's queue is not observable from Node; give the waiters time to join it.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(executeLimited(activation, providerHost())).resolves.toEqual({
      status: "interrupted",
      cause: "CODEMODE_COMPILER_BUSY",
    });
    resumeCompilation();
    for (const completion of await Promise.all(admitted)) {
      expect(completion).toMatchObject({ status: "completed", value: 42 });
    }
  } finally {
    resumeCompilation();
    await limitedServer.close();
  }
});
test("a completion waits until its host's revocation holds", async () => {
  const host = providerHost();
  let finishRevocation!: () => void;
  const revocation = new Promise<void>((resolve) => {
    finishRevocation = resolve;
  });
  let revoking = false;
  // Over Workers RPC, the caller's host revokes its tools on a later round trip.
  const remoteHost = {
    ...host,
    async close() {
      revoking = true;
      await revocation;
      await host.close();
    },
  };
  let settled = false;
  const completion = execute(
    { ...base, kind: "immediate", code: 'async () => await store.write("done")' },
    remoteHost,
  ).finally(() => {
    settled = true;
  });
  await expect.poll(() => revoking).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(!settled, "the completion must not outrun revocation");
  finishRevocation();
  expect(await completion).toMatchObject({ status: "completed", value: "done" });
});
test("log floods complete with truncated logs", async () => {
  const completion = await execute(
    {
      ...base,
      kind: "immediate",
      code: `() => { for (let i = 0; i < ${CODEMODE_LIMITS.maxLogs * 2}; i++) console.log("message"); return 42; }`,
    },
    providerHost(),
  );
  assert(completion.status === "completed");
  assert(completion.value === 42);
  expect(completion.logs).toHaveLength(CODEMODE_LIMITS.maxLogs);
  expect(completion.logs.at(-1)).toMatchObject({ channel: "codemode", text: "Logs truncated." });
});
