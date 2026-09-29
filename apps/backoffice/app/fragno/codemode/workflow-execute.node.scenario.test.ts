import { beforeAll, afterAll, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";
import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/transport/codemode-node-client";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { createNodeBackofficeRuntimeConfiguration } from "@/backoffice-runtime/node/node-runtime-env";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";

let server: Awaited<ReturnType<typeof createCodemodeTestServer>>;
beforeAll(async () => {
  server = await createCodemodeTestServer();
});
afterAll(async () => {
  await server?.close();
});

test("Node checkpoints and replays workflow codemode across fresh Worker WebSockets", async () => {
  const { runtimeEnv: env } = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  });
  const scope = { kind: "org" as const, orgId: "org-1" };
  const execution = createBackofficeSystemExecution(scope);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Node checkpoint replay through ordinary Worker sockets",
      env,
      files: backofficeFiles.workspaceStarter({
        "automations/remote-checkpointed.workflow.js": `defineWorkflow(
        { name: "remote-checkpointed", checkpoint: "step" },
        async (_event, step) => {
          const first = await step.do("first", async () => {
            const previous = await context.current.store.get({ key: "checkpoint-count" });
            const count = Number(previous?.value ?? 0) + 1;
            await context.current.store.set({ key: "checkpoint-count", value: String(count) });
            return count;
          });
          const second = await step.do("second", async () => await step.do("first", async () => first + 1));
          return await step.do("third", async () => second + 1);
        },
      );`,
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          path: "/workspace/automations/remote-checkpointed.workflow.js",
          remoteWorkflowName: "remote-checkpointed",
          instanceId: "remote-checkpointed-1",
          event: {
            id: "remote-event",
            scope,
            source: "scenario",
            eventType: "remote.workflow.requested",
            occurredAt: "2026-09-29T00:00:00.000Z",
            payload: {},
            actors: execution.actors,
          },
        }),
        then.workflow.instance({
          remoteWorkflowName: "remote-checkpointed",
          instanceId: "remote-checkpointed-1",
          status: "complete",
          output: 3,
        }),
        then.workflow.steps({
          remoteWorkflowName: "remote-checkpointed",
          instanceId: "remote-checkpointed-1",
          include: ["first", "second", "third"],
        }),
        when.codemode.run({
          orgId: "org-1",
          code: 'async () => await context.current.store.get({ key: "checkpoint-count" })',
        }),
        then.assert("completed step did not repeat its mutation during replay", (ctx) => {
          expect(ctx.codemodeRuns.at(-1)?.result.result).toMatchObject({ value: "1" });
        }),
      ],
    }),
  );
});

test("remote event consumption and sleep resume with Date values intact", async () => {
  const { runtimeEnv: env } = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  });
  const scope = { kind: "org" as const, orgId: "org-1" };
  const execution = createBackofficeSystemExecution(scope);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "remote wait, onConsume, and sleep",
      env,
      files: backofficeFiles.workspaceStarter({
        "automations/remote-wait.workflow.js": `defineWorkflow({ name: "remote-wait" }, async (event, step) => {
        const received = await step.waitForEvent("ready", { type: "ready", onConsume: async (tx, received) => {
          tx.emit({ timestamp: received.timestamp.toISOString() });
        } });
        await step.sleepUntil("cooldown", new Date(event.timestamp.getTime() + 1000));
        return await step.do("save", async () => {
          await context.current.store.set({ key: "event-value", value: received.payload.value });
          return { value: received.payload.value, preservedDate: received.timestamp instanceof Date };
        });
      });`,
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          path: "/workspace/automations/remote-wait.workflow.js",
          remoteWorkflowName: "remote-wait",
          instanceId: "remote-wait-1",
          event: {
            id: "wait-event",
            scope,
            source: "scenario",
            eventType: "remote.wait.requested",
            occurredAt: "2026-09-29T00:00:00Z",
            payload: {},
            actors: execution.actors,
          },
        }),
        then.workflow.instance({
          remoteWorkflowName: "remote-wait",
          instanceId: "remote-wait-1",
          status: "waiting",
          waitingFor: "ready",
        }),
        when.workflow.sendEvent({
          orgId: "org-1",
          instanceId: "remote-wait-1",
          type: "ready",
          payload: { value: "delivered" },
        }),
        when.time.advance("2 seconds"),
        then.workflow.instance({
          remoteWorkflowName: "remote-wait",
          instanceId: "remote-wait-1",
          status: "complete",
          output: { value: "delivered", preservedDate: true },
        }),
        then.store.entry({ orgId: "org-1", key: "event-value", value: "delivered" }),
      ],
    }),
  );
});

test("interruption preserves host retry scheduling without falsely committing tool effects", async () => {
  const execute = createCodemodeNodeExecutor(server);
  const scope = { kind: "org" as const, orgId: "org-1" };
  const execution = createBackofficeSystemExecution(scope);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "interrupted step retries through the Node runner",
      env: {
        codemode: {
          remoteExecutor: (activation, host) => execute({ ...activation, timeoutMs: 750 }, host),
        },
      },
      files: backofficeFiles.workspaceStarter({
        "automations/remote-interrupted.workflow.js": `defineWorkflow({ name: "remote-interrupted" }, async (_event, step) => {
        return await step.do("interrupted", { retries: { limit: 1, delay: "1 second" } }, async () => {
          const previous = await context.current.store.get({ key: "interrupted-effects" });
          await context.current.store.set({ key: "interrupted-effects", value: String(Number(previous?.value ?? 0) + 1) });
          await new Promise(() => {});
          return "must not commit";
        });
      });`,
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          path: "/workspace/automations/remote-interrupted.workflow.js",
          remoteWorkflowName: "remote-interrupted",
          instanceId: "remote-interrupted-1",
          event: {
            id: "interrupted-event",
            scope,
            source: "scenario",
            eventType: "remote.interrupted.requested",
            occurredAt: "2026-09-29T00:00:00Z",
            payload: {},
            actors: execution.actors,
          },
        }),
        then.store.entry({ orgId: "org-1", key: "interrupted-effects", value: "1" }),
        when.time.advance("2 seconds"),
        then.workflow.instance({
          remoteWorkflowName: "remote-interrupted",
          instanceId: "remote-interrupted-1",
          status: "errored",
        }),
        then.store.entry({ orgId: "org-1", key: "interrupted-effects", value: "2" }),
      ],
      options: { allowErroredWorkflows: true },
    }),
  );
});
