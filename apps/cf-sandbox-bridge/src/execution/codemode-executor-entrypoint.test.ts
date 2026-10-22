import { afterAll, beforeAll, expect, test } from "vitest";

import { createCodemodeBridgeTestServer } from "../testing/codemode-bridge-test-server";

let server: Awaited<ReturnType<typeof createCodemodeBridgeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeBridgeTestServer();
});
afterAll(async () => {
  await server?.close();
});

const base = {
  dependencies: {},
  modules: {},
  timeoutMs: 10_000,
  providers: [{ name: "store", tools: ["write"] }],
};

test("a service-binding caller runs source with its own providers", async () => {
  expect(
    await server.executeThroughService({
      ...base,
      kind: "immediate",
      code: 'async () => ({ wrote: await store.write("hello") })',
    }),
  ).toMatchObject({
    completion: { status: "completed", value: { wrote: "hello" } },
    writes: ["hello"],
  });
});

test("workflow step capabilities and guest callbacks survive the caller, bridge, and guest hops", async () => {
  const result = await server.executeThroughService({
    ...base,
    kind: "workflow",
    event: {
      id: "event-1",
      instanceId: "instance-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      payload: {},
    },
    entry: "/workflow.js",
    modules: {
      "/workflow.js": `export default defineWorkflow({ name: "bridge-hops" }, async (_event, step) => {
      const listened = await step.do("listen", async (tx) => {
        await tx.emit({ phase: "listening" });
        const emissions = await tx.previousEmissions();
        const payload = await new Promise((resolve) => {
          tx.onEvent("ready", async (event) => {
            event.consume();
            resolve(event.payload);
          });
          store.write("subscribed");
        });
        return { emissions, payload };
      });
      const nested = await step.do("outer", async () => await step.do("inner", async () => "nested"));
      const approval = await step.waitForEvent("approval", {
        type: "approved",
        onConsume: async (tx, event) => {
          await tx.emit({ consumed: event.type });
        },
      });
      return { listened, nested, approved: approval.payload.approved };
    });`,
    },
  });
  expect(result).toEqual({
    completion: expect.objectContaining({
      status: "completed",
      value: {
        listened: { emissions: [{ phase: "listening" }], payload: { value: 42 } },
        nested: "nested",
        approved: true,
      },
    }),
    writes: ["subscribed"],
    emitted: [{ phase: "listening" }, { consumed: "approved" }],
    consumed: ["ready-1"],
    scopes: [null, null, { stepKey: "do:outer", parentStepKey: null, depth: 0 }],
    // The subscription ends with its step, and the host revokes it.
    listeners: 0,
  });
});
