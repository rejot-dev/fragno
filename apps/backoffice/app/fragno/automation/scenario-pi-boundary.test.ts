import { describe, expect, test, vi, assert } from "vitest";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { automationActorsSchema } from "@/fragno/automation/actors";
import { PI_CODEMODE_WORKFLOW } from "@/fragno/automation/engine/pi-codemode-workflow";
import { createPiToolFactory, type PiSessionFileSystemContext } from "@/fragno/pi/pi";
import { createPiCodemodeRuntime } from "@/fragno/pi/pi-codemode";
import { BACKOFFICE_PI_WORKFLOW_NAME } from "@/fragno/pi/pi-shared";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return {
    DurableObject: MockDurableObject,
    RpcTarget: class MockRpcTarget {},
    WorkerEntrypoint: class MockWorkerEntrypoint {},
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "./scenario";

const sessionListRequest = () =>
  new Request(
    "https://pi.test/api/pi/workflows/interactive-chat-workflow/sessions?scope=org%3Aorg-1",
  );

type PiAuthorityScenarioVars = {
  sessionId?: string;
  execCodeMode?: AgentTool;
  adminSessionId?: string;
  memberSessionId?: string;
  adminTool?: AgentTool;
  memberTool?: AgentTool;
  persistedActors?: unknown;
};

const loadPiSessionExecution = async (
  ctx: BackofficeScenarioContext<PiAuthorityScenarioVars>,
  orgId: string,
  sessionId: string,
): Promise<BackofficeExecutionContext> => {
  const scope = { kind: "org" as const, orgId };
  const response = await ctx.runtime.objects.automations
    .forOrg(orgId)
    .fetchWithContext(
      new Request(
        `https://pi.test/api/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/instances/${sessionId}?scope=org%3A${orgId}`,
      ),
      {
        execution: createBackofficeSystemExecution(scope),
        propagationContext: null,
      },
    );

  assert(response.status === 200);
  const instance = (await response.json()) as {
    details: { status: string };
    meta: { params: { metadata?: Record<string, unknown> } };
  };
  expect(instance.details.status).not.toMatch(/complete|errored|terminated/);

  return {
    scope,
    actors: automationActorsSchema.parse(instance.meta.params.metadata?.__backofficeActors),
  };
};

const createScenarioPiExecCodeMode = async (
  ctx: BackofficeScenarioContext<PiAuthorityScenarioVars>,
  orgId: string,
  sessionId: string,
  execution: BackofficeExecutionContext,
): Promise<AgentTool> => {
  const loader = ctx.runtime.env.LOADER;
  if (!loader) {
    throw new Error("Pi authority scenario requires a Worker Loader.");
  }

  const kernel = new BackofficeKernel(ctx.runtime.services);
  const sessionFileSystemContext: PiSessionFileSystemContext = {
    scope: execution.scope,
    objects: ctx.runtime.services.objects,
    kernel,
    execution,
    runtimeConfig: ctx.runtime.services.config,
  };
  const createTools = createPiToolFactory({
    sessionFileSystems: new Map([[sessionId, Promise.resolve(ctx.files.forOrg(orgId))]]),
    sessionFileSystemContext,
    codemode: createPiCodemodeRuntime({
      LOADER: loader,
      compileWorker: ctx.runtime.env.compileWorker,
    }),
    runtimeToolContext: (toolExecution) =>
      createRouteBackedRuntimeContext({
        runtime: ctx.runtime.services,
        kernel,
        execution: toolExecution,
      }),
  });
  const tool = (await createTools({ sessionId, execution })).execCodeMode;
  if (!tool) {
    throw new Error("Pi execCodeMode tool is unavailable.");
  }
  return tool;
};

const executeInternalManageOperation = async (tool: AgentTool, toolCallId: string) =>
  await tool.execute(toolCallId, {
    code: "async () => await internal.filesSeedExecute({})",
  } as never);

const executeStoreMutation = async (tool: AgentTool, toolCallId: string, key: string) =>
  await tool.execute(toolCallId, {
    code: `async () => await store.set(${JSON.stringify({ key, value: "allowed" })})`,
  } as never);

const createScenarioPiSession = async ({
  ctx,
  orgId,
  userId,
  metadata,
}: {
  ctx: BackofficeScenarioContext<PiAuthorityScenarioVars>;
  orgId: string;
  userId: string;
  metadata?: Record<string, unknown>;
}) => {
  const scope = { kind: "org" as const, orgId };
  const response = await ctx.runtime.objects.automations.forOrg(orgId).fetchWithContext(
    new Request(
      `https://pi.test/api/pi/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/sessions?scope=org%3A${orgId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata: {
            model: { provider: "openai", name: "gpt-5.6-luna" },
            ...metadata,
          },
          input: {},
        }),
      },
    ),
    {
      execution: createBackofficeUserExecution({ scope, userId }),
      propagationContext: null,
    },
  );
  assert(response.status === 200);
  return (await response.json()) as { id: string };
};

const piCommandRequest = (orgId: string, sessionId: string) =>
  new Request(
    `https://pi.test/api/pi/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/sessions/${sessionId}/command?scope=org%3A${orgId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", input: { text: "run" } }),
    },
  );

describe("scenario Pi boundary", () => {
  test("requires and validates the same trusted execution context as production", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "scenario Pi trusted context",
        fakes: ({ fake }) => ({ pi: fake.pi() }),
        steps: ({ then }) => [
          then.assert("raw Pi session fetch is denied", async (ctx) => {
            const response = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .fetch(sessionListRequest());
            assert(response.status === 403);
            await expect(response.json()).resolves.toMatchObject({
              code: "context-access-denied",
            });
          }),
          then.assert("deferred user context resolves current authority", async (ctx) => {
            const response = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .fetchWithContext(sessionListRequest(), {
                execution: createBackofficeUserExecution({
                  scope: { kind: "org", orgId: "org-1" },
                  userId: "missing-user",
                }),
                propagationContext: null,
              });
            assert(response.status === 403);
            expect(ctx.fakes.pi?.getSessionCalls).toEqual([]);
          }),
          then.assert("fake Pi rejects mismatched execution scope", async (ctx) => {
            await expect(
              ctx.fakes.pi?.fetchWithContext(sessionListRequest(), {
                execution: createBackofficeUserExecution({
                  scope: { kind: "org", orgId: "org-2" },
                  userId: "user-1",
                }),
                propagationContext: null,
              }),
            ).rejects.toThrow("scope does not match");
          }),
        ],
      }),
    );
  });

  test("persists trusted actors without treating the session principal as an access owner", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<PiAuthorityScenarioVars>({
        name: "Pi session actors establish execution authority without ownership checks",
        vars: () => ({}),
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "attacker", role: "admin" }),
          given.auth.organization({
            id: "org-1",
            ownerUserId: "owner",
            ownerRoles: ["owner"],
          }),
          given.pi.configured({ orgId: "org-1" }),
        ],
        steps: ({ then }) => [
          then.assert("caller-authored actors are overwritten", async (ctx) => {
            const forgedActors = createBackofficeUserExecution({
              scope: { kind: "org", orgId: "org-1" },
              userId: "attacker",
            }).actors;
            const session = await createScenarioPiSession({
              ctx,
              orgId: "org-1",
              userId: "owner",
              metadata: { __backofficeActors: forgedActors },
            });
            ctx.vars.sessionId = session.id;

            const execution = await loadPiSessionExecution(ctx, "org-1", session.id);
            expect(execution.actors.principal).toMatchObject({ id: "owner", type: "user" });
          }),
          then.assert("another authorized principal can invoke the session", async (ctx) => {
            const sessionId = ctx.vars.sessionId;
            if (!sessionId) {
              throw new Error("Pi session id was not captured.");
            }

            const response = await ctx.runtime.objects.automations
              .forOrg("org-1")
              .fetchWithContext(piCommandRequest("org-1", sessionId), {
                execution: createBackofficeUserExecution({
                  scope: { kind: "org", orgId: "org-1" },
                  userId: "attacker",
                }),
                propagationContext: null,
              });
            assert(response.status === 202);
            await expect(response.json()).resolves.toMatchObject({ accepted: true });
          }),
          then.assert(
            "generic workflow creation cannot bypass the Pi session boundary",
            async (ctx) => {
              const scope = { kind: "org" as const, orgId: "org-1" };
              const response = await ctx.runtime.objects.automations
                .forOrg("org-1")
                .fetchWithContext(
                  new Request(
                    `https://pi.test/api/workflows/${BACKOFFICE_PI_WORKFLOW_NAME}/instances`,
                    {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        id: "bypass-session",
                        params: {
                          metadata: { model: { provider: "openai", name: "gpt-5.6-luna" } },
                          __piSession: { name: null },
                        },
                      }),
                    },
                  ),
                  {
                    execution: createBackofficeUserExecution({ scope, userId: "owner" }),
                    propagationContext: null,
                  },
                );
              assert(response.status === 404);
            },
          ),
        ],
      }),
    );
  });

  test("schedules and executes a durable codemode workflow submitted by a Pi session", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<PiAuthorityScenarioVars>({
        name: "Pi session schedules and executes durable codemode",
        vars: () => ({}),
        setup: ({ given }) => [
          given.auth.user({ id: "user-1", role: "admin" }),
          given.auth.organization({
            id: "org-1",
            name: "Pi Durable Codemode Org",
            ownerUserId: "user-1",
            ownerRoles: ["owner"],
          }),
          given.pi.configured({ orgId: "org-1" }),
        ],
        steps: ({ when, then, runner }) => [
          when.pi.createSession({
            orgId: "org-1",
            captureSessionIdAs: "sessionId",
          }),
          then.assert("the Pi codemode tool schedules the durable workflow", async (ctx) => {
            const sessionId = ctx.vars.sessionId;
            if (!sessionId) {
              throw new Error("Pi session id was not captured.");
            }

            const execution = await loadPiSessionExecution(ctx, "org-1", sessionId);
            const tool = await createScenarioPiExecCodeMode(ctx, "org-1", sessionId, execution);
            const result = await tool.execute("durable-codemode", {
              code: `defineWorkflow(
  { name: "pi-created-durable-workflow" },
  async (_event, step) => {
    await step.do("write durable result", async () => {
      await store.set({
        key: "pi/durable-codemode",
        value: "executed",
        category: ["test", "pi"],
      });
    });
    return { executed: true };
  },
);`,
            } as never);
            const details = result.details as {
              run?: { workflowName: string; instanceId: string };
              scheduleError?: string;
            };

            expect(details.scheduleError).toBeUndefined();
            expect(details.run).toMatchObject({ workflowName: PI_CODEMODE_WORKFLOW });
          }),
          runner.drain(),
          then.store.entry({
            orgId: "org-1",
            key: "pi/durable-codemode",
            value: "executed",
          }),
          then.workflow.noErrored({ orgId: "org-1" }),
        ],
      }),
    );
  });

  test("uses the session creator's current permissions for every Pi tool execution", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<PiAuthorityScenarioVars>({
        name: "Pi session authority follows current creator permissions",
        vars: () => ({}),
        setup: ({ given }) => [
          given.auth.user({
            id: "user-1",
            email: "admin@example.com",
            role: "admin",
          }),
          given.auth.organization({
            id: "org-1",
            name: "Pi Authority Org",
            ownerUserId: "user-1",
            ownerRoles: ["owner"],
          }),
          given.pi.configured({ orgId: "org-1" }),
        ],
        steps: ({ when, then }) => [
          then.assert("configure the database-backed workspace", async (ctx) => {
            await ctx.runtime.objects.upload
              .forOrg("org-1")
              .setAdminConfig({ provider: "database" }, "org-1");
          }),
          when.pi.createSession({
            orgId: "org-1",
            captureSessionIdAs: "sessionId",
          }),
          then.assert(
            "the running session executes with its administrator creator",
            async (ctx) => {
              const sessionId = ctx.vars.sessionId;
              if (!sessionId) {
                throw new Error("Pi session id was not captured.");
              }

              const execution = await loadPiSessionExecution(ctx, "org-1", sessionId);
              expect(execution.actors.principal).toMatchObject({
                scope: "internal",
                type: "user",
                id: "user-1",
                role: "principal",
              });

              const tool = await createScenarioPiExecCodeMode(ctx, "org-1", sessionId, execution);
              ctx.vars.execCodeMode = tool;
              await expect(
                executeInternalManageOperation(tool, "admin-seed"),
              ).resolves.toBeDefined();
            },
          ),

          when.auth.setUserRole({ userId: "user-1", role: "user" }),
          then.assert("the same running session observes the role downgrade", async (ctx) => {
            const tool = ctx.vars.execCodeMode;
            if (!tool) {
              throw new Error("Pi execCodeMode tool was not captured.");
            }

            await expect(executeInternalManageOperation(tool, "downgraded-seed")).rejects.toThrow(
              "required permission",
            );
          }),

          when.auth.setUserRole({ userId: "user-1", role: "admin" }),
          then.assert("the same running session observes restored permissions", async (ctx) => {
            const tool = ctx.vars.execCodeMode;
            if (!tool) {
              throw new Error("Pi execCodeMode tool was not captured.");
            }

            await expect(
              executeInternalManageOperation(tool, "restored-seed"),
            ).resolves.toBeDefined();
          }),

          when.auth.setUserStatus({ userId: "user-1", status: "banned" }),
          then.assert("the same running session observes a creator ban", async (ctx) => {
            const tool = ctx.vars.execCodeMode;
            if (!tool) {
              throw new Error("Pi execCodeMode tool was not captured.");
            }

            await expect(executeInternalManageOperation(tool, "banned-seed")).rejects.toThrow(
              "required permission",
            );
          }),
        ],
      }),
    );
  });

  test("reauthorizes membership-backed sessions after reload and isolates concurrent sessions", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<PiAuthorityScenarioVars>({
        name: "Pi session membership and isolation",
        vars: () => ({}),
        setup: ({ given }) => [
          given.auth.user({ id: "admin", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({
            id: "org-1",
            ownerUserId: "admin",
            ownerRoles: ["owner"],
          }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
          given.pi.configured({ orgId: "org-1" }),
        ],
        steps: ({ when, then }) => [
          then.assert("configure the database-backed workspace", async (ctx) => {
            await ctx.runtime.objects.upload
              .forOrg("org-1")
              .setAdminConfig({ provider: "database" }, "org-1");
          }),
          then.assert("create isolated administrator and member sessions", async (ctx) => {
            const [adminSession, memberSession] = await Promise.all([
              createScenarioPiSession({ ctx, orgId: "org-1", userId: "admin" }),
              createScenarioPiSession({ ctx, orgId: "org-1", userId: "member" }),
            ]);
            ctx.vars.adminSessionId = adminSession.id;
            ctx.vars.memberSessionId = memberSession.id;

            const [adminExecution, memberExecution] = await Promise.all([
              loadPiSessionExecution(ctx, "org-1", adminSession.id),
              loadPiSessionExecution(ctx, "org-1", memberSession.id),
            ]);
            expect(adminExecution.actors.principal).toMatchObject({ id: "admin" });
            expect(memberExecution.actors.principal).toMatchObject({ id: "member" });

            const [adminTool, memberTool] = await Promise.all([
              createScenarioPiExecCodeMode(ctx, "org-1", adminSession.id, adminExecution),
              createScenarioPiExecCodeMode(ctx, "org-1", memberSession.id, memberExecution),
            ]);
            ctx.vars.adminTool = adminTool;
            ctx.vars.memberTool = memberTool;

            await expect(
              executeStoreMutation(memberTool, "member-store", "member-before-remove"),
            ).resolves.toBeDefined();
            await expect(
              executeInternalManageOperation(adminTool, "admin-manage"),
            ).resolves.toBeDefined();
            await expect(
              executeInternalManageOperation(memberTool, "member-manage"),
            ).rejects.toThrow("required permission");
          }),

          when.auth.removeMember({ orgId: "org-1", userId: "member" }),
          then.assert("the existing member session loses organization permissions", async (ctx) => {
            const tool = ctx.vars.memberTool as AgentTool | undefined;
            if (!tool) {
              throw new Error("Member Pi tool was not captured.");
            }
            await expect(
              executeStoreMutation(tool, "removed-store", "member-after-remove"),
            ).rejects.toThrow("required permission");
          }),

          then.assert("reloading from workflow metadata retains the correct owner", async (ctx) => {
            const sessionId = ctx.vars.adminSessionId;
            if (typeof sessionId !== "string") {
              throw new Error("Admin session was not captured.");
            }
            const reloadedExecution = await loadPiSessionExecution(ctx, "org-1", sessionId);
            const reloadedTool = await createScenarioPiExecCodeMode(
              ctx,
              "org-1",
              sessionId,
              reloadedExecution,
            );
            await expect(
              executeInternalManageOperation(reloadedTool, "reloaded-manage"),
            ).resolves.toBeDefined();
          }),
        ],
      }),
    );
  });

  test("deferred or missing-user executions resolve current authority instead of stored grants", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<PiAuthorityScenarioVars>({
        name: "Pi deferred execution reauthorization",
        vars: () => ({}),
        setup: ({ given }) => [
          given.auth.user({ id: "creator", role: "admin" }),
          given.auth.organization({
            id: "org-1",
            ownerUserId: "creator",
            ownerRoles: ["owner"],
          }),
          given.pi.configured({ orgId: "org-1" }),
        ],
        steps: ({ when, then }) => [
          then.assert("capture a durable actor envelope from the running session", async (ctx) => {
            const session = await createScenarioPiSession({
              ctx,
              orgId: "org-1",
              userId: "creator",
            });
            const execution = await loadPiSessionExecution(ctx, "org-1", session.id);
            ctx.vars.sessionId = session.id;
            ctx.vars.persistedActors = JSON.parse(JSON.stringify(execution.actors));
          }),
          when.auth.setUserRole({ userId: "creator", role: "user" }),
          then.assert("a later deferred execution observes revoked permissions", async (ctx) => {
            const sessionId = ctx.vars.sessionId;
            if (!sessionId) {
              throw new Error("Pi session id was not captured.");
            }
            const execution: BackofficeExecutionContext = {
              scope: { kind: "org", orgId: "org-1" },
              actors: automationActorsSchema.parse(ctx.vars.persistedActors),
            };
            const tool = await createScenarioPiExecCodeMode(ctx, "org-1", sessionId, execution);
            await expect(executeInternalManageOperation(tool, "deferred-manage")).rejects.toThrow(
              "required permission",
            );
          }),
          then.assert(
            "an actor envelope for a deleted or missing creator fails closed",
            async (ctx) => {
              const missingExecution = createBackofficeUserExecution({
                scope: { kind: "org", orgId: "org-1" },
                userId: "deleted-user",
              });
              const tool = await createScenarioPiExecCodeMode(
                ctx,
                "org-1",
                "deleted-user-session",
                missingExecution,
              );
              await expect(
                executeStoreMutation(tool, "deleted-store", "deleted-user"),
              ).rejects.toThrow("required permission");
            },
          ),
        ],
      }),
    );
  });
});
