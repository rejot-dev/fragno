import { beforeAll, afterAll, assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createCodemodeNodeExecutor } from "@fragno-dev/codemode/remote/codemode-node-executor";
import { createCodemodeTestServer } from "@fragno-dev/codemode/testing/codemode-test-server";

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createNodeBackofficeRuntimeConfiguration } from "@/backoffice-runtime/node/node-runtime-env";
import { CODEMODE_WORKFLOW } from "@/fragno/automation/engine/codemode-invocation";
import { createWorkflowsRouteCaller } from "@/fragno/automation/route-callers";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { runBackofficeCodemode } from "./execute";
import { runBackofficeJavaScriptModule } from "./javascript-module-execute";

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
            scopeRestriction: null,
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
          scope: { kind: "org", orgId: "org-1" },
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
            scopeRestriction: null,
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
          remoteExecutor: (activation, host) =>
            execute(
              activation.kind === "module-build" ? activation : { ...activation, timeoutMs: 750 },
              host,
            ),
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
            scopeRestriction: null,
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

test("permanent guest failures bypass the real Node runner's configured retry policy", async () => {
  const { runtimeEnv: env } = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  });
  const scope = { kind: "org" as const, orgId: "org-1" };
  const execution = createBackofficeSystemExecution(scope);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Cap'n Web preserves non-retryable callback outcomes",
      env,
      files: backofficeFiles.workspaceStarter({
        "automations/remote-permanent.workflow.js": `defineWorkflow({ name: "remote-permanent" }, async (_event, step) => {
        return await step.do("permanent", { retries: { limit: 3, delay: "1 second" } }, async () => {
          const previous = await context.current.store.get({ key: "permanent-attempts" });
          await context.current.store.set({ key: "permanent-attempts", value: String(Number(previous?.value ?? 0) + 1) });
          const error = new Error("permanent rejection");
          error.name = "NonRetryableError";
          throw error;
        });
      });`,
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.workflow.createInstance({
          orgId: "org-1",
          path: "/workspace/automations/remote-permanent.workflow.js",
          remoteWorkflowName: "remote-permanent",
          instanceId: "remote-permanent-1",
          event: {
            id: "permanent-event",
            scope,
            scopeRestriction: null,
            source: "scenario",
            eventType: "remote.permanent.requested",
            occurredAt: "2026-10-05T00:00:00Z",
            payload: {},
            actors: execution.actors,
          },
        }),
        then.workflow.instance({
          remoteWorkflowName: "remote-permanent",
          instanceId: "remote-permanent-1",
          status: "errored",
        }),
        when.time.advance("5 seconds"),
        then.store.entry({ orgId: "org-1", key: "permanent-attempts", value: "1" }),
      ],
      options: { allowErroredWorkflows: true },
    }),
  );
});

test("Node explains denied MCP discovery for immediate, module, and scheduled execution", async () => {
  const { runtimeEnv: env } = createNodeBackofficeRuntimeConfiguration({
    bridgeUrl: server.url,
    bridgeApiKey: server.apiKey,
    env: {},
  });
  const scope = { kind: "org" as const, orgId: "org-1" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "MCP discovery denial survives the Worker bridge and durable history",
      env,
      files: backofficeFiles.workspaceStarter({
        "automations/remote-mcp.workflow.js": `defineWorkflow({ name: "remote-mcp" }, async (_event, step) => {
          return await step.do("call MCP", { retries: { limit: 1, delay: "1 second" } }, async () => await mcp_agensi.search({}));
        });`,
      }),
      setup: ({ given }) => [given.organization.exists({ id: "org-1", name: "Ada Labs" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          scope,
          code: `async () => await router.create({
            id: "remote-mcp",
            name: "Remote MCP",
            enabled: true,
            trigger: { kind: "schedule", cadence: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() } },
            action: {
              kind: "start_workflow",
              authority: { kind: "organization-automation", grants: [] },
              workflowScriptPath: "/workspace/automations/remote-mcp.workflow.js",
              instanceIdTemplate: "remote-mcp-1",
            },
          })`,
        }),
        then.assert(
          "immediate and module execution explain only missing MCP providers",
          async (ctx) => {
            const systemExecution = createBackofficeSystemExecution(scope);
            const execution = {
              ...systemExecution,
              actors: {
                ...systemExecution.actors,
                principal: {
                  scope: "internal" as const,
                  type: "automation" as const,
                  id: "automation-route:remote-mcp",
                  role: "principal" as const,
                },
              },
            };
            const toolContext = createBackofficeToolContext(
              createCodemodeRouteBackedRuntimeContext({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution,
                billingOrganizationId: null,
              }),
            );
            assert(env.codemode);
            const options = { env: env.codemode, toolContext, families: runtimeToolFamilies };
            const denied = await runBackofficeCodemode({
              ...options,
              code: "async () => await mcp_agensi.search({})",
            });
            expect(denied.error).toContain("Required permission: mcp.servers.read.");
            expect(denied.error).toContain("Calling MCP tools also requires mcp.tools.call.");
            const unrelated = await runBackofficeCodemode({
              ...options,
              code: "async () => await missingHelper()",
            });
            assert(unrelated.error === "missingHelper is not defined");
            const successful = await runBackofficeCodemode({ ...options, code: "async () => 42" });
            expect(successful.error).toBeUndefined();
            assert(successful.result === 42);

            const moduleDenied = await runBackofficeJavaScriptModule({
              ...options,
              program: { kind: "source", code: "await mcp_agensi.search({});" },
            });
            expect(moduleDenied.error).toContain("Required permission: mcp.servers.read.");
            const moduleUnrelated = await runBackofficeJavaScriptModule({
              ...options,
              program: { kind: "source", code: 'throw new Error("unrelated module failure");' },
            });
            assert(moduleUnrelated.error === "unrelated module failure");
            const moduleSuccessful = await runBackofficeJavaScriptModule({
              ...options,
              program: { kind: "source", code: 'console.log("non-MCP module completed");' },
            });
            expect(moduleSuccessful.error).toBeUndefined();
            expect(moduleSuccessful.logs).toContain("non-MCP module completed");
          },
        ),
        when.time.advance("2 minutes"),
        when.time.advance("2 seconds"),
        then.workflow.instance({
          remoteWorkflowName: "remote-mcp",
          instanceId: "remote-mcp-1",
          status: "errored",
        }),
        then.assert(
          "the persisted step and instance explain the missing discovery grant",
          async (ctx) => {
            const workflows = createWorkflowsRouteCaller({
              object: ctx.runtime.objects.automations.forOrg("org-1"),
              context: {
                execution: createBackofficeSystemExecution(scope),
                propagationContext: null,
              },
            });
            const pathParams = { workflowName: CODEMODE_WORKFLOW, instanceId: "remote-mcp-1" };
            const instance = await workflows("GET", "/:workflowName/instances/:instanceId", {
              pathParams,
            });
            assert(instance.type === "json");
            expect(instance.data.details.error?.message).toContain(
              "Required permission: mcp.servers.read.",
            );
            const history = await workflows("GET", "/:workflowName/instances/:instanceId/history", {
              pathParams,
            });
            assert(history.type === "json");
            expect(history.data.steps).toContainEqual(
              expect.objectContaining({
                name: "call MCP",
                status: "errored",
                attempts: 2,
                error: expect.objectContaining({
                  name: "BackofficeForbiddenError",
                  message: expect.stringContaining("Required permission: mcp.servers.read."),
                }),
              }),
            );
          },
        ),
      ],
      options: { allowErroredWorkflows: true },
    }),
  );
});
