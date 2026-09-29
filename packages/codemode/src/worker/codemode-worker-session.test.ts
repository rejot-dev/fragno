import { afterAll, beforeAll, expect, test, assert } from "vitest";

import { RemoteWorkflowSuspendedError } from "@fragno-dev/workflows/remote-workflow";
import { NonRetryableError } from "@fragno-dev/workflows/workflow";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { createCodemodeTestServer } from "../testing/codemode-test-server";
import { CodemodeInterruptedError } from "../transport/codemode-errors";
import { createCodemodeNodeExecutor } from "../transport/codemode-node-client";
import type { CodemodeHostOperation, CodemodeRemoteExecutor } from "../transport/codemode-protocol";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
let execute: CodemodeRemoteExecutor;
beforeAll(async () => {
  server = await createCodemodeTestServer();
  execute = createCodemodeNodeExecutor(server);
});
afterAll(async () => {
  await server?.close();
});

function providerHost() {
  const writes: unknown[] = [];
  return {
    writes,
    async handle(call: CodemodeHostOperation) {
      if (
        call.operation !== "provider.call" ||
        call.provider !== "store" ||
        call.tool !== "write"
      ) {
        throw new Error("Unexpected tool");
      }
      const [value] = JSON.parse(call.argsJson);
      writes.push(value);
      return JSON.stringify({ result: value });
    },
    close() {},
    async settle() {
      return null;
    },
  };
}

const base = {
  dependencies: {},
  timeoutMs: 10_000,
  providers: [{ name: "store", tools: ["write"] }],
};

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
  const completion = await execute({ ...base, kind, code }, providerHost());
  expect(completion).toMatchObject({
    status: "failed",
    error: { message: "boom" },
  });
});

test("object throws preserve string message properties", async () => {
  const completion = await execute(
    { ...base, kind: "immediate", code: '() => { throw { message: "object boom" }; }' },
    providerHost(),
  );
  expect(completion).toMatchObject({
    status: "failed",
    error: { message: "object boom" },
  });
});

test.each([
  { label: "empty string", code: '() => { throw ""; }' },
  { label: "empty Error message", code: "() => { throw new Error(); }" },
])("$label throws use a non-empty execution failure", async ({ code }) => {
  const completion = await execute({ ...base, kind: "immediate", code }, providerHost());
  expect(completion).toMatchObject({
    status: "failed",
    error: { message: "CODEMODE_EXECUTION_FAILED" },
  });
});

test.each(["immediate", "module"] as const)(
  "%s source preserves the configured evaluation timeout",
  async (kind) => {
    const completion = await execute(
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
    );
    expect(completion).toMatchObject({
      status: "failed",
      error: { message: "Execution timed out" },
    });
  },
);

test("guest cannot fetch or inspect host credentials", async () => {
  const completion = await execute(
    {
      ...base,
      kind: "immediate",
      code: 'async () => { try { await fetch("https://example.com"); } catch { return { denied: true, credential: globalThis.SANDBOX_API_KEY }; } }',
    },
    providerHost(),
  );
  expect(completion).toMatchObject({
    status: "completed",
    value: { denied: true, credential: undefined },
  });
});

test("unauthorized clients never execute a provider operation", async () => {
  const unauthorized = createCodemodeNodeExecutor({ ...server, apiKey: "incorrect" });
  const host = providerHost();
  await expect(
    unauthorized({ ...base, kind: "immediate", code: '() => store.write("wrong")' }, host),
  ).rejects.toThrow("HTTP 401");
  expect(host.writes).toEqual([]);
});

test("a workflow callback can call Node while Node awaits that callback", async () => {
  const host = providerHost();
  const completion = await execute(
    {
      ...base,
      kind: "workflow",
      code: 'async (_event, step) => await step.do("outer", async () => await store.write("nested"))',
      event: { id: "event", instanceId: "instance", timestamp: new Date(), payload: {} },
      agentAvailable: false,
    },
    {
      ...host,
      async handle(call, guest) {
        if (call.operation === "step.do") {
          return await guest({
            operation: "callback.step",
            callbackId: call.callbackId,
            txId: 1,
            scope: { stepKey: "do:outer", parentStepKey: null, depth: 0 },
          });
        }
        return await host.handle(call);
      },
    },
  );
  expect(completion).toMatchObject({ status: "completed", value: "nested" });
  expect(host.writes).toEqual(["nested"]);
});

const workflowBase = {
  ...base,
  kind: "workflow" as const,
  event: {
    id: "event",
    instanceId: "instance",
    timestamp: new Date("2026-09-29T00:00:00Z"),
    payload: {},
  },
  agentAvailable: false,
};

test.each(["logs", "workflowProgram", "RpcTarget"])(
  "workflow rejects generated binding provider name %s before compilation",
  async (name) => {
    const completion = await execute(
      {
        ...workflowBase,
        providers: [{ name, tools: [] }],
        code: "async () => undefined",
      },
      providerHost(),
    );
    expect(completion).toMatchObject({
      status: "failed",
      error: { message: `Provider name "${name}" is reserved` },
    });
  },
);

test("sleepUntil carries a Date to Node and propagates typed suspension", async () => {
  const host = providerHost();
  const completion = await execute(
    {
      ...workflowBase,
      code: 'async (event, step) => { console.log("before sleep"); await step.sleepUntil("wait", event.timestamp); }',
    },
    {
      ...host,
      async handle(call) {
        if (call.operation !== "step.sleepUntil") {
          throw new Error("Unexpected operation");
        }
        expect(call.timestamp).toEqual(workflowBase.event.timestamp);
        throw new RemoteWorkflowSuspendedError({
          type: "sleep",
          stepKey: "sleep:wait",
          runAt: call.timestamp as Date,
        });
      },
      async settle() {
        return {
          type: "sleep" as const,
          stepKey: "sleep:wait",
          runAt: workflowBase.event.timestamp,
        };
      },
    },
  );
  expect(completion).toMatchObject({
    status: "suspended",
    reason: { type: "sleep", stepKey: "sleep:wait", runAt: workflowBase.event.timestamp },
    logs: ["before sleep"],
  });
});

test("transaction emissions flush before the callback result returns to Node", async () => {
  const emitted: unknown[] = [];
  const host = providerHost();
  const completion = await execute(
    {
      ...workflowBase,
      code: 'async (_event, step) => await step.do("emit", async (tx) => { tx.emit({ committed: true }); return 42; })',
    },
    {
      ...host,
      async handle(call, guest) {
        if (call.operation === "tx.emit") {
          emitted.push(call.payload);
          return undefined;
        }
        if (call.operation !== "step.do") {
          throw new Error("Unexpected operation");
        }
        const value = await guest({
          operation: "callback.step",
          callbackId: call.callbackId,
          txId: 1,
          scope: { stepKey: "do:emit", parentStepKey: null, depth: 0 },
        });
        expect(emitted).toEqual([{ committed: true }]);
        return value;
      },
    },
  );
  expect(completion).toMatchObject({ status: "completed", value: 42 });
});

test("guest-defined agent tools reenter the guest and can call a Node provider", async () => {
  const host = providerHost();
  const completion = await execute(
    {
      ...workflowBase,
      agentAvailable: true,
      code: `async (_event, step) => await step.agent.prompt("prompt", { text: "write", tools: [defineTool({ name: "write", description: "write value", parameters: { type: "object" }, execute: async (_id, input) => await store.write(input) })] })`,
    },
    {
      ...host,
      async handle(call, guest) {
        if (call.operation !== "agent.prompt") {
          return await host.handle(call);
        }
        if (call.callbackId === null) {
          throw new Error("Tool callback required");
        }
        return await guest({
          operation: "callback.agentTool",
          callbackId: call.callbackId,
          toolId: call.input.tools[0].id,
          toolCallId: "tool-call",
          input: { fromAgent: true },
        });
      },
    },
  );
  expect(completion).toMatchObject({ status: "completed", value: { fromAgent: true } });
  expect(host.writes).toEqual([{ fromAgent: true }]);
});

test("permanent callback errors retain their workflow failure class on Node", async () => {
  const host = providerHost();
  let callbackError: unknown;
  await execute(
    {
      ...workflowBase,
      code: 'async (_event, step) => await step.do("fail", async () => { const error = new Error("permanent"); error.name = "NonRetryableError"; throw error; })',
    },
    {
      ...host,
      async handle(call, guest) {
        if (call.operation !== "step.do") {
          throw new Error("Unexpected operation");
        }
        try {
          return await guest({
            operation: "callback.step",
            callbackId: call.callbackId,
            txId: 1,
            scope: { stepKey: "do:fail", parentStepKey: null, depth: 0 },
          });
        } catch (error) {
          callbackError = error;
          throw error;
        }
      },
    },
  );
  expect(callbackError).toBeInstanceOf(NonRetryableError);
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
    const host = providerHost();
    try {
      const activations = Promise.all(
        Array.from({ length: CODEMODE_LIMITS.maxBridgeCompilations }, () =>
          executeLimited(
            {
              ...workflowBase,
              timeoutMs: 1_000,
              code: 'async () => await store.write("must not execute after timeout")',
            },
            host,
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
        await expect(executeLimited(replacement, host)).resolves.toMatchObject({
          status: "failed",
          error: { message: "CODEMODE_COMPILATION_LIMIT_EXCEEDED" },
        });
      }
      expect(compilationCount).toBe(CODEMODE_LIMITS.maxBridgeCompilations);
      expect(host.writes).toEqual([]);

      stalled = false;
      resumeCompilation();
      await expect
        .poll(async () => {
          const completion = await executeLimited(replacement, host);
          return completion.status === "failed" ? completion.error.message : completion.status;
        })
        .toBe("completed");
      expect(host.writes).toEqual(["recovered"]);
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
      expect(completion).toMatchObject({ status: "completed" });
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
    const host = providerHost();
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
              {
                ...host,
                async handle() {
                  throw new RemoteWorkflowSuspendedError(reason);
                },
                async settle() {
                  return reason;
                },
              },
            )
          : await executeWarning(
              {
                ...base,
                kind: "immediate",
                code: `async () => { ${logSource} ${status === "failed" ? 'throw new Error("guest failure");' : "return 42;"} }`,
              },
              host,
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
        {
          ...base,
          kind: "immediate",
          code: "() => 42",
        },
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
