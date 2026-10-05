import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { once } from "node:events";

import { RemoteWorkflowSuspendedError } from "@fragno-dev/workflows/remote-workflow";
import { NonRetryableError, WaitForEventTimeoutError } from "@fragno-dev/workflows/workflow";
import { RpcSession } from "capnweb";
import WebSocket from "ws";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  CODEMODE_EXECUTION_HTTP_PATH,
  type CodemodeExecutionCapability,
  type CodemodeRemoteExecutor,
  type CodemodeWorkflowHost,
  type CodemodeWorkflowTransactionHost,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError } from "../execution/codemode-errors";
import { createCodemodeHost } from "../host/codemode-host-capabilities";
import { createCodemodeTestServer } from "../testing/codemode-test-server";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";
import { createCodemodeNodeExecutor } from "./codemode-node-executor";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
let execute: CodemodeRemoteExecutor;
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
    async do(parentScope, name, _config, callback) {
      const stepKey = parentScope ? `${parentScope.stepKey}>do:${name}` : `do:${name}`;
      return await callback(transaction, {
        stepKey,
        parentStepKey: parentScope?.stepKey ?? null,
        depth: parentScope ? parentScope.depth + 1 : 0,
      });
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
  timeoutMs: 10_000,
  providers: [{ name: "store", tools: ["write"] }],
};
const workflowBase = {
  ...base,
  kind: "workflow" as const,
  event: {
    id: "event",
    instanceId: "instance",
    timestamp: new Date("2026-09-29T00:00:00Z"),
    payload: {},
  },
};

test("the bridge rejects mismatched application versions and accepts only one execution per socket", async () => {
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
      () => host.close(),
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
      await expect(
        bridge.execute({ ...request, protocolVersion: 1 } as never, host.capabilities),
      ).rejects.toThrow();
      expect(compilations).toEqual(0);
      await expect(bridge.execute(request, host.capabilities)).resolves.toMatchObject({
        status: "completed",
        value: 42,
      });
      await expect(bridge.execute(request, host.capabilities)).rejects.toThrow(
        "CODEMODE_INVALID_START",
      );
      assert(compilations === 1);
    } finally {
      bridge[Symbol.dispose]();
    }
  } finally {
    host.close();
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
    logs: ["guest log"],
    workflowDefinition: null,
  });
  expect(host.writes).toEqual([{ saved: true }]);
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
    {
      ...base,
      kind: "module",
      code: 'await store.write("module body"); export default () => store.write("wrong");',
    },
    host,
  );
  expect(completion.status, JSON.stringify(completion)).toBe("completed");
  expect(host.writes).toEqual(["module body"]);
});

test.each([
  { kind: "immediate" as const, code: '() => { throw "boom"; }' },
  { kind: "module" as const, code: 'throw "boom";' },
])("$kind source reports primitive throws as failures", async ({ kind, code }) => {
  expect(await execute({ ...base, kind, code }, providerHost())).toMatchObject({
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
          ...base,
          kind,
          timeoutMs: 50,
          code:
            kind === "module"
              ? "await new Promise(() => {});"
              : "async () => await new Promise(() => {})",
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
            ...workflowBase,
            providers,
            code: `async (_event, step) => await step.do("restricted", ${callback})`,
          }
        : { ...base, kind, providers, code: callback },
      host,
    );
    expect(completion).toMatchObject({
      status: "completed",
      value: {
        allowed: { saved: true },
        denied: [
          "CODEMODE_TOOL_NOT_ALLOWED",
          "CODEMODE_TOOL_NOT_ALLOWED",
          "CODEMODE_TOOL_NOT_ALLOWED",
          "CODEMODE_TOOL_NOT_ALLOWED",
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
            ...workflowBase,
            providers,
            code: 'async (_event, step) => await step.do("restricted", async () => await store.write("wrong"))',
          }
        : { ...base, kind, providers, code: 'async () => await store.write("wrong")' },
      host,
    );
    expect(completion).toMatchObject({
      status: "failed",
      error: { message: "CODEMODE_TOOL_NOT_ALLOWED" },
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
test("a workflow callback calls Node reentrantly and nested steps receive their host-owned scope", async () => {
  const scopes: unknown[] = [];
  const source = workflowHost();
  const host = providerHost(
    workflowHost({
      async do(parentScope, name, config, callback) {
        scopes.push(parentScope);
        return await source.do(parentScope, name, config, callback);
      },
    }),
  );
  const completion = await execute(
    {
      ...workflowBase,
      code: 'async (_event, step) => await step.do("outer", async () => await step.do("inner", async () => await store.write("nested")))',
    },
    host,
  );
  expect(completion).toMatchObject({ status: "completed", value: "nested" });
  expect(host.writes).toEqual(["nested"]);
  expect(scopes).toEqual([null, { stepKey: "do:outer", parentStepKey: null, depth: 0 }]);
});
test.each(["logs", "workflowProgram", "RpcTarget"])(
  "workflow rejects generated binding provider name %s before compilation",
  async (name) => {
    expect(
      await execute(
        { ...workflowBase, providers: [{ name, tools: [] }], code: "async () => undefined" },
        providerHost(),
      ),
    ).toMatchObject({
      status: "failed",
      error: { message: `Provider name "${name}" is reserved` },
    });
  },
);
test("sleepUntil carries a Date to Node and propagates typed suspension", async () => {
  const host = providerHost(
    workflowHost({
      async sleepUntil(_scope, _name, timestamp) {
        expect(timestamp).toEqual(workflowBase.event.timestamp);
        throw new RemoteWorkflowSuspendedError({
          type: "sleep",
          stepKey: "sleep:wait",
          runAt: timestamp as Date,
        });
      },
    }),
  );
  expect(
    await execute(
      {
        ...workflowBase,
        code: 'async (event, step) => { console.log("before sleep"); await step.sleepUntil("wait", event.timestamp); }',
      },
      host,
    ),
  ).toMatchObject({
    status: "suspended",
    reason: { type: "sleep", stepKey: "sleep:wait", runAt: workflowBase.event.timestamp },
    logs: ["before sleep"],
  });
});
test("transaction emissions flush before callback completion and retained transactions lose authority", async () => {
  const emitted: unknown[] = [];
  const host = providerHost(workflowHost({}, emitted));
  const completion = await execute(
    {
      ...workflowBase,
      code: `async (_event, step) => {
    let retained;
    const value = await step.do("emit", async (tx) => { retained = tx; tx.emit({ committed: true }); return 42; });
    try { await retained.previousEmissions(); return "must not work"; } catch { return value; }
  }`,
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
      ...workflowBase,
      code: `async (_event, step) => await step.do("listen", async (tx) => {
    const event = await new Promise((resolve) => { tx.onEvent("ready", async (event) => {
      await store.write(event.payload);
      event.consume();
      resolve(event.payload);
    }); });
    return event;
  })`,
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
      async do(scope, name, config, callback) {
        try {
          return await source.do(scope, name, config, callback);
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
    }),
  );
  await execute(
    {
      ...workflowBase,
      code: 'async (_event, step) => await step.do("fail", async () => { const error = new Error("permanent"); error.name = "NonRetryableError"; throw error; })',
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
        ...workflowBase,
        code: `async (_event, step) => {
    try { await step.waitForEvent("ready", { type: "ready" }); }
    catch (error) { return error.name; }
  }`,
      },
      host,
    ),
  ).toMatchObject({ status: "completed", value: "WaitForEventTimeoutError" });
});

test("guest-forged suspension cannot schedule work without a Node host decision", async () => {
  await expect(
    execute(
      {
        ...workflowBase,
        code: 'async () => { throw { __fragnoRemoteWorkflowSuspended: true, reason: { type: "sleep", stepKey: "sleep:forged", runAt: new Date("2030-01-01") } }; }',
      },
      providerHost(),
    ),
  ).rejects.toThrow("CODEMODE_UNISSUED_SUSPENSION");
});

test.each(["resolve", "reject"] as const)(
  "timed-out activations retain compiler admission until stalled calls %s",
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
              ...workflowBase,
              timeoutMs: 1_000,
              code: 'async () => await store.write("must not execute after timeout")',
            },
            providerHost(null, writes),
          ).then(
            () => null,
            (error: unknown) => error,
          ),
        ),
      );
      await expect.poll(() => compilationCount).toBe(CODEMODE_LIMITS.maxBridgeCompilations);
      for (const error of await activations) {
        expect(error).toBeInstanceOf(CodemodeInterruptedError);
      }
      const replacement = {
        ...base,
        kind: "immediate" as const,
        code: 'async () => await store.write("recovered")',
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await executeLimited(replacement, providerHost(null, writes))).toMatchObject({
          status: "failed",
          error: { message: "CODEMODE_COMPILATION_LIMIT_EXCEEDED" },
        });
      }
      expect(compilationCount).toBe(CODEMODE_LIMITS.maxBridgeCompilations);
      expect(writes).toEqual([]);
      stalled = false;
      resumeCompilation();
      await expect
        .poll(async () => {
          const completion = await executeLimited(replacement, providerHost(null, writes));
          return completion.status === "failed" ? completion.error.message : completion.status;
        })
        .toBe("completed");
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
        kind === "workflow" ? { ...workflowBase, code } : { ...base, kind, code },
        providerHost(),
      );
      assert(completion.status === "completed");
      expect(completion.logs).toHaveLength(CODEMODE_LIMITS.maxLogs);
      assert(completion.logs[0] === "compiler warning");
      assert(completion.logs.at(-2) === "guest log");
      assert(completion.logs.at(-1) === "[codemode] Logs truncated.");
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
    const reason = {
      type: "sleep" as const,
      stepKey: "sleep:wait",
      runAt: workflowBase.event.timestamp,
    };
    try {
      const logSource = `console.log("🙂".repeat(${CODEMODE_LIMITS.maxLogBytes / 4}));`;
      const executeWarning = createCodemodeNodeExecutor(warningServer);
      const completion =
        status === "suspended"
          ? await executeWarning(
              {
                ...workflowBase,
                code: `async (event, step) => { ${logSource} await step.sleepUntil("wait", event.timestamp); }`,
              },
              providerHost(
                workflowHost({
                  async sleepUntil() {
                    throw new RemoteWorkflowSuspendedError(reason);
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
      expect(completion.logs).toEqual([warning, "[codemode] Logs truncated."]);
      expect(new TextEncoder().encode(completion.logs.join("")).byteLength).toBeLessThanOrEqual(
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
      expect(completion).toMatchObject({ status: "completed", value: 42 });
      expect(completion.logs).toEqual(overflow ? ["[codemode] Logs truncated."] : [warning]);
    } finally {
      await warningServer.close();
    }
  },
);
test("log floods fail with bounded output", async () => {
  const completion = await execute(
    {
      ...base,
      kind: "immediate",
      code: '() => { for (let i = 0; i < 10000; i++) console.log("message"); }',
    },
    providerHost(),
  );
  expect(completion).toMatchObject({
    status: "failed",
    error: { message: "CODEMODE_LOG_LIMIT_EXCEEDED" },
  });
  expect(completion.logs.length).toBeLessThanOrEqual(1000);
});
