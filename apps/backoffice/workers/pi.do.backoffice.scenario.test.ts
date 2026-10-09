import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  openNodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { PostHog } from "posthog-node";

import {
  createRegistry,
  defineExtension,
  hook,
  ToolTask,
  type ConversationView,
  type HarnessSettings,
} from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeRequestExecution,
  BACKOFFICE_SYSTEM_ACTORS,
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import { issueBackofficeTokenResultSchema } from "@/fragno/auth/contracts";
import type { CodemodeWorkflowParams } from "@/fragno/automation/engine/codemode-invocation";
import { createRouteBackedAutomationRouterRuntime } from "@/fragno/automation/routing-route-runtime";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import type { PiAgentConfig } from "@/fragno/pi-manager/pi-agent-contract";
import { BackofficePostHogContext, captureBackofficeServerException } from "@/posthog.server";
import {
  createPiManagerSession,
  fetchPiManagerSessions,
  submitPiManagerPrompt,
} from "@/routes/backoffice/sessions/data";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";
import { createPiPostHogExtension } from "./lib/pi-posthog-extension";
import { InMemoryPiObject } from "./pi.do";

const scenarioObjects = allLocalObjects;

const PI_SCENARIO_AVAILABLE_MODELS = [
  { provider: "faux", modelId: "faux-1", label: "Faux 1" },
] as const;

function scriptedAgents(
  responses: FauxResponseStep[],
  settings?: HarnessSettings,
): LocalBackofficeObjects {
  return {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses(responses);
      const models = createModels();
      models.setProvider(faux.provider);
      return new InMemoryPiObject({
        state,
        runtime,
        options: { models, registry: createRegistry(), ...(settings ? { settings } : {}) },
        openStorage: openPiSessionStore,
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      });
    },
  };
}

async function request(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  route: string,
  body: unknown,
) {
  return await runtime.objects.piManager.for(execution.scope).http.fetchAuthorized(
    new Request(`https://pi-manager.test/api/pi-manager${route}`, {
      method: body === null ? "GET" : "POST",
      headers: body === null ? {} : { "content-type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    }),
    { execution, propagationContext: null },
  );
}

async function createAgent(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
) {
  const created = await request(runtime, execution, "/sessions", {
    name: "Backoffice agent",
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "Keep the session-specific instruction.",
    billingOrganizationId: "org-1",
    actors: BACKOFFICE_SYSTEM_ACTORS,
    userAuthority: { role: "admin" },
  });
  assert.equal(created.status, 201, await created.clone().text());
  return await created.json<PiAgentConfig>();
}

async function prompt(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  config: PiAgentConfig,
) {
  const submitted = await request(runtime, execution, `/sessions/${config.sessionId}/prompts`, {
    requestId: "backoffice-prompt",
    content: "Use the Backoffice context.",
  });
  assert.equal(submitted.status, 202, await submitted.clone().text());
}

async function view(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  config: PiAgentConfig,
) {
  const response = await request(runtime, execution, `/sessions/${config.sessionId}/view`, null);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json<ConversationView>();
}

test("durable Pi discovers scoped skills and executes read, search, codemode and manager-backed Pi tools", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "durable-tool-scenario" },
  });
  let config: PiAgentConfig;
  const objectOverrides = scriptedAgents([
    (context) => {
      if (
        context.messages.filter((message) => message.role === "user").at(-1)?.content ===
        "First child prompt"
      ) {
        return fauxAssistantMessage("First child answer.");
      }
      const system = context.messages.filter((message) => message.role === "system");
      const rendered = JSON.stringify(system);
      expect(rendered).toContain("Keep the session-specific instruction.");
      expect(rendered.match(/# Backoffice System Guidance/g)).toHaveLength(1);
      expect(rendered).toContain("Scoped durable skill");
      expect(rendered).toContain("/workspace/skills/durable/SKILL.md");
      expect(rendered).toContain("/static/skills/");
      expect(rendered).toContain("/static/codemode/");
      expect(
        system.flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name),
      ).toEqual(expect.arrayContaining(["read", "search", "execCodeMode"]));
      return fauxAssistantMessage(
        [
          fauxToolCall("read", { path: "/workspace/durable-notes.txt", offset: 2, limit: 1 }),
          fauxToolCall("search", { query: "Durable marker", glob: "/workspace/durable-notes.txt" }),
          fauxToolCall("execCodeMode", {
            code: `async () => {
          await state.writeFile({ path: "/workspace/durable-result.txt", content: "executed through Backoffice" });
          const child = await pi.createSession({
            name: "Durable child",
            model: { provider: "faux", modelId: "faux-1" },
          });
          const first = await context.current.pi.runPrompt({ sessionId: child.sessionId, content: "First child prompt" });
          const second = await context.current.pi.runPrompt({ sessionId: child.sessionId, content: "Second child prompt" });
          const detail = await pi.getSession({ sessionId: child.sessionId });
          const sessions = await pi.listSessions({ pageSize: 10 });
          return {
            child: child.sessionId,
            sessions: sessions.sessions.map(session => session.sessionId),
            first: first.assistantText,
            second: second.assistantText,
            inputs: detail.view.entries.filter(entry => entry.kind === "pi.user").length,
          };
        }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      if (
        context.messages.filter((message) => message.role === "user").at(-1)?.content ===
        "Second child prompt"
      ) {
        return fauxAssistantMessage("Second child answer.");
      }
      const results = context.messages.filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(3);
      assert(
        results.every((result) => !result.isError),
        JSON.stringify(results),
      );
      expect(JSON.stringify(results)).toContain("Durable marker");
      expect(JSON.stringify(results)).toContain("First child answer.");
      expect(JSON.stringify(results)).toContain("Second child answer.");
      expect(results.find((result) => result.toolName === "execCodeMode")?.details).toMatchObject({
        result: { inputs: 2 },
      });
      return fauxAssistantMessage("Backoffice tool run finished.");
    },
  ]);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi Backoffice environment and tools",
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/durable-notes.txt",
          content: "first line\nDurable marker\nlast line",
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/skills/durable/SKILL.md",
          content:
            "---\nname: scoped-durable\ndescription: Scoped durable skill\n---\nRead the scoped notes before acting.",
        }),
      ],
      steps: ({ then }) => [
        then.assert("create, run and settle a real Backoffice agent", async ({ runtime }) => {
          config = await createAgent(runtime, execution);
          expect(config.actors).toEqual(execution.actors);
          await prompt(runtime, execution, config);
          await runtime.drain();
          const transcript = await view(runtime, execution, config);
          expect(JSON.stringify(transcript.entries)).toContain("Backoffice tool run finished.");
          const directory = await (
            await request(runtime, execution, "/sessions", null)
          ).json<{ sessions: PiAgentConfig[] }>();
          expect(directory.sessions).toHaveLength(2);
          expect(
            directory.sessions.find((session) => session.name === "Durable child")?.actors,
          ).toEqual(execution.actors);
        }),
        then.files.contains({
          orgId: "org-1",
          path: "/workspace/durable-result.txt",
          text: "executed through Backoffice",
        }),
      ],
    }),
  );
});

for (const revocation of ["restricted", "disabled", "deleted"] as const) {
  test(`durable Pi resolves linked-user route grants and denies model calls after the route is ${revocation}`, async () => {
    const scope = { kind: "org", orgId: "org-1" } as const;
    const execution = createBackofficeUserExecution({ scope, userId: "member" });
    const workflowPath = "/workspace/automations/delegated-pi.workflow.js";
    let config: PiAgentConfig;
    let modelCalls = 0;
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `durable Pi live route authority after ${revocation}`,
        options: { drain: false },
        objects: {
          ...scenarioObjects,
          ...scriptedAgents([
            (context) => {
              modelCalls += 1;
              expect(JSON.stringify(context.messages)).toContain("# Backoffice System Guidance");
              return fauxAssistantMessage(
                [
                  fauxToolCall("execCodeMode", {
                    code: `async () => await store.set({ key: "linked-pi/result", value: "written" })`,
                  }),
                ],
                { stopReason: "toolUse" },
              );
            },
            (context) => {
              modelCalls += 1;
              const result = context.messages.find((message) => message.role === "toolResult");
              assert(result?.role === "toolResult");
              expect(result.isError, JSON.stringify(result)).toBe(false);
              return fauxAssistantMessage("The linked-user agent answered.");
            },
          ]),
        },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner", ownerRoles: ["owner"] }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
          given.identity.binding({ orgId: "org-1", externalId: "1001", userId: "member" }),
          given.direct.file({
            orgId: "org-1",
            path: workflowPath,
            content: `defineWorkflow({ name: "delegated-pi" }, async (event, step) => {
              const session = await step.do("create linked-user agent", async () => await pi.createSession({
                requestId: "linked-user-agent",
                name: "Linked-user agent",
                model: { provider: "faux", modelId: "faux-1" },
              }));
              return await step.do("run linked-user agent", async () => await pi.runPrompt({
                sessionId: session.sessionId,
                requestId: "route-prompt",
                content: "Answer on behalf of the linked user.",
              }));
            });`,
          }),
          given.router.route({
            orgId: "org-1",
            id: "telegram-pi-linking",
            name: "Linked-user Pi",
            enabled: true,
            priority: 100,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.chatId", op: "eq", value: "1001" },
            },
            action: {
              kind: "start_workflow",
              authority: { kind: "linked-user", grants: "inherit" },
              workflowScriptPath: workflowPath,
              instanceIdTemplate: "linked-pi-${event.id}",
            },
          }),
        ],
        steps: ({ when, then, runner }) => [
          when.automation.ingestEvent({
            id: "linked-pi-message",
            scopeRestriction: null,
            scope,
            source: "telegram",
            eventType: "message.received",
            occurredAt: "2026-10-04T16:23:00.000Z",
            payload: { chatId: "1001", messageId: "1", fromUserId: "1001", text: "Hello" },
            actors: {
              initiator: {
                scope: "external",
                source: "telegram",
                type: "chat",
                id: "1001",
                role: "initiator",
              },
              principal: null,
              delegation: [],
            },
            subject: { orgId: "org-1" },
          }),
          then.assert(
            "the durable agent honors its creator's route delegate",
            async ({ runtime }) => {
              await runtime.drain();
              const directory = await (
                await request(runtime, execution, "/sessions", null)
              ).json<{ sessions: PiAgentConfig[] }>();
              expect(directory.sessions).toHaveLength(1);
              const session = directory.sessions[0];
              assert(session);
              config = session;
              expect(config.actors.principal).toEqual(execution.actors.principal);
              expect(config.actors.delegation).toEqual([
                {
                  scope: "internal",
                  type: "automation",
                  id: "automation-route:telegram-pi-linking",
                  role: "delegate",
                },
              ]);
              const transcript = await view(runtime, execution, config);
              expect(JSON.stringify(transcript.entries)).toContain(
                "The linked-user agent answered.",
              );
              expect(modelCalls).toBe(2);
            },
          ),
          then.store.entry({ orgId: "org-1", key: "linked-pi/result", value: "written" }),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          then.assert("revoke the owning route's current authority", async ({ runtime }) => {
            const router = createRouteBackedAutomationRouterRuntime({
              object: runtime.objects.automations.for(scope),
              execution: createBackofficeUserExecution({ scope, userId: "owner" }),
            });
            if (revocation === "deleted") {
              assert(await router.deleteRoute({ id: "telegram-pi-linking" }));
            } else {
              await router.updateRoute({
                id: "telegram-pi-linking",
                ...(revocation === "disabled"
                  ? { enabled: false }
                  : {
                      action: {
                        kind: "start_workflow",
                        authority: {
                          kind: "linked-user",
                          grants: [BACKOFFICE_PERMISSION.pi.read],
                        },
                        workflowScriptPath: workflowPath,
                        instanceIdTemplate: "linked-pi-${event.id}",
                      },
                    }),
              });
            }
          }),
          then.assert(
            "a human prompt cannot bypass the persisted route delegate",
            async ({ runtime }) => {
              await prompt(runtime, execution, config);
              await runtime.drain();
              const response = await request(
                runtime,
                execution,
                `/sessions/${config.sessionId}/submissions/backoffice-prompt`,
                null,
              );
              expect(await response.json()).toMatchObject({ status: "unanswered" });
              const transcript = await view(runtime, execution, config);
              expect(JSON.stringify(transcript.entries)).toContain(
                "PI_AGENT_MODEL_REQUEST_FAILED: A delegated actor does not have the required capability grant.",
              );
              expect(modelCalls).toBe(2);
            },
          ),
        ],
      }),
    );
  });
}

test("durable Pi preserves an explicit null child billing owner", async () => {
  const execution = createBackofficeSystemExecution({ kind: "system" });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi explicit null child billing owner",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          fauxAssistantMessage(
            [
              fauxToolCall("execCodeMode", {
                code: `async () => await pi.createSession({
                requestId: "explicit-null-child",
                name: "Unbilled child",
                model: { provider: "faux", modelId: "faux-1" },
                billingOrganizationId: null,
              });`,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("The child session was created."),
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("explicit null overrides inherited billing", async ({ runtime }) => {
          const parent = await createAgent(runtime, execution);
          await prompt(runtime, execution, parent);
          await runtime.drain();

          const directory = await (
            await request(runtime, execution, "/sessions", null)
          ).json<{ sessions: PiAgentConfig[] }>();
          expect(directory.sessions).toHaveLength(2);
          expect(
            directory.sessions.find((session) => session.sessionId === parent.sessionId),
          ).toMatchObject({
            billingOrganizationId: "org-1",
          });
          expect(
            directory.sessions.find((session) => session.name === "Unbilled child"),
          ).toMatchObject({
            billingOrganizationId: null,
          });
        }),
      ],
    }),
  );
});

test("durable Pi delivers committed model usage to its persisted billing owner", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "durable-billing-scenario" },
  });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi committed usage billing",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents(
          [
            fauxAssistantMessage("Usage was durably billed."),
            fauxAssistantMessage("Compaction usage was durably billed."),
          ],
          { compaction: { keepRecentTokens: 1 } },
        ),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("bill the cumulative committed model usage once", async ({ runtime }) => {
          const config = await createAgent(runtime, execution);
          await prompt(runtime, execution, config);
          await runtime.drain();

          const period = new Date(runtime.now()).toISOString().slice(0, 7);
          const trackers = await runtime.objects.billing.forOrg("org-1").commands.getTrackers({
            scope: execution.scope,
            period,
            pageSize: 100,
          });
          const totalTokens = trackers.trackers.find(
            (tracker) => tracker.meter === "ai.tokens.total",
          );
          expect(Number(totalTokens?.quantity)).toBeGreaterThan(0);
          assert(totalTokens?.eventCount === "1");

          const compacted = await request(
            runtime,
            execution,
            `/sessions/${config.sessionId}/compact`,
            { instructions: "Preserve the billed answer." },
          );
          assert.equal(compacted.status, 202, await compacted.clone().text());
          await runtime.drain();
          const afterCompaction = await runtime.objects.billing
            .forOrg("org-1")
            .commands.getTrackers({ scope: execution.scope, period, pageSize: 100 });
          const compactedTotalTokens = afterCompaction.trackers.find(
            (tracker) => tracker.meter === "ai.tokens.total",
          );
          expect(Number(compactedTotalTokens?.quantity)).toBeGreaterThan(
            Number(totalTokens?.quantity),
          );
          assert(compactedTotalTokens?.eventCount === "2");

          await runtime.drain();
          const afterDuplicateDrain = await runtime.objects.billing
            .forOrg("org-1")
            .commands.getTrackers({ scope: execution.scope, period, pageSize: 100 });
          expect(
            afterDuplicateDrain.trackers.find((tracker) => tracker.meter === "ai.tokens.total"),
          ).toEqual(compactedTotalTokens);
        }),
      ],
    }),
  );
});

test("durable Pi persists creator provenance rather than JWT authority and rechecks the billing organization before generation", async () => {
  const scope = { kind: "user", userId: "member" } as const;
  const execution = createBackofficeRequestExecution({
    scope,
    userId: "member",
    verifiedRequestAuthority: {
      scopeRestriction: null,
      role: "user",
      organizationId: "org-1",
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  let config: PiAgentConfig;
  let modelCalls = 0;
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi current billing authority",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          () => {
            modelCalls += 1;
            return fauxAssistantMessage("Must not run.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.auth.user({ id: "owner", role: "admin" }),
        given.auth.user({ id: "member", role: "user" }),
        given.auth.organization({
          id: "org-1",
          name: "Billing organization",
          ownerUserId: "owner",
          ownerRoles: ["owner"],
        }),
        given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
      ],
      steps: ({ when, then }) => [
        then.assert(
          "creation strips forged actors and never persists token authority",
          async ({ runtime }) => {
            const missingOwner = await request(runtime, execution, "/sessions", {
              name: null,
              model: { provider: "faux", modelId: "faux-1" },
              instructions: "",
            });
            assert.equal(missingOwner.status, 400, await missingOwner.clone().text());
            const foreignOwner = await request(runtime, execution, "/sessions", {
              name: null,
              model: { provider: "faux", modelId: "faux-1" },
              billingOrganizationId: "foreign-org",
            });
            assert.equal(foreignOwner.status, 403, await foreignOwner.clone().text());
            config = await createAgent(runtime, execution);
            expect(config.actors).toEqual(execution.actors);
            expect(config).not.toHaveProperty("userAuthority");
            const directory = await (
              await request(runtime, execution, `/sessions/${config.sessionId}`, null)
            ).json();
            expect(directory).toMatchObject({
              actors: execution.actors,
              billingOrganizationId: "org-1",
            });
            expect(directory).not.toHaveProperty("userAuthority");
          },
        ),
        when.auth.removeMember({ orgId: "org-1", userId: "member" }),
        then.assert(
          "the still-valid JWT cannot authorize a deferred model call after revocation",
          async ({ runtime }) => {
            await prompt(runtime, execution, config);
            await runtime.drain();
            const submission = await (
              await request(
                runtime,
                execution,
                `/sessions/${config.sessionId}/submissions/backoffice-prompt`,
                null,
              )
            ).json();
            expect(submission).toMatchObject({ status: "unanswered" });
            expect(modelCalls).toBe(0);
            const transcript = await view(runtime, execution, config);
            expect(JSON.stringify(transcript.entries)).not.toContain("Must not run.");
          },
        ),
      ],
    }),
  );
});

for (const revokeBillingAccess of [false, true]) {
  test(`durable Pi workflows inherit billing across nested saved workflows and restart${revokeBillingAccess ? " without retaining revoked authority" : ""}`, async () => {
    const scope = { kind: "user", userId: "member" } as const;
    const execution = createBackofficeUserExecution({ scope, userId: "member" });
    const promptOperation = revokeBillingAccess ? "pi.submitPrompt" : "pi.runPrompt";
    const savedWorkflowCode = `defineWorkflow({ name: "saved-sentence-checker" }, async (event, step) => {
      const classifier = await step.do("create saved classifier", async () => await pi.createSession({
        requestId: event.instanceId + ":classifier",
        name: "Saved classifier",
        model: { provider: "faux", modelId: "faux-1" },
      }));
      await step.waitForEvent("wait for sentence", { type: "sentence" });
      return await step.do("submit sentence", async () => await ${promptOperation}({
        sessionId: classifier.sessionId,
        requestId: event.instanceId + ":sentence",
        content: "Classify this sentence",
      }));
    });`;
    const workflowCode = `defineWorkflow({ name: "inline-sentence-checker" }, async (event, step) => {
      const classifier = await step.do("create inline classifier", async () => await pi.createSession({
        requestId: event.instanceId + ":classifier",
        name: "Inline classifier",
        model: { provider: "faux", modelId: "faux-1" },
      }));
      await step.do("start nested workflow", async () => await context.current.workflow.createInstance({
        path: "/workspace/automations/saved-sentence-checker.workflow.js",
        instanceId: "saved-checker",
      }));
      await step.waitForEvent("wait for sentence", { type: "sentence" });
      return await step.do("submit sentence", async () => await ${promptOperation}({
        sessionId: classifier.sessionId,
        requestId: event.instanceId + ":sentence",
        content: "Classify this sentence",
      }));
    });`;
    let inlineInstanceId: string;
    let classifiers: PiAgentConfig[];
    let tokensBeforeResume: { quantity: string; eventCount: string };
    let classifierCalls = 0;
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `inherited workflow billing${revokeBillingAccess ? " after revocation" : ""}`,
        files: backofficeFiles.workspaceStarter({
          "automations/saved-sentence-checker.workflow.js": savedWorkflowCode,
        }),
        options: { drain: false },
        objects: {
          ...scenarioObjects,
          ...scriptedAgents([
            (context) => {
              if (
                context.messages.filter((message) => message.role === "user").at(-1)?.content ===
                "Classify this sentence"
              ) {
                classifierCalls += 1;
                return fauxAssistantMessage("Not naughty.");
              }
              return fauxAssistantMessage([fauxToolCall("execCodeMode", { code: workflowCode })], {
                stopReason: "toolUse",
              });
            },
            (context) => {
              const results = context.messages.filter((message) => message.role === "toolResult");
              expect(results).toHaveLength(1);
              expect(results[0]?.isError, JSON.stringify(results)).toBe(false);
              return fauxAssistantMessage("Sentence checker is waiting.");
            },
          ]),
        },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.auth.user({ id: "owner", role: "admin" }),
          given.auth.user({ id: "member", role: "user" }),
          given.auth.organization({ id: "org-1", ownerUserId: "owner", ownerRoles: ["owner"] }),
          given.auth.member({ orgId: "org-1", userId: "member", roles: ["member"] }),
        ],
        steps: ({ when, then, runner }) => [
          then.assert(
            "inline and nested workflows persist the parent's billing selection",
            async ({ runtime }) => {
              const config = await createAgent(runtime, execution);
              await prompt(runtime, execution, config);
              await runtime.drain();
              const workflow = createRouteBackedAutomationWorkflowRuntime({
                object: runtime.objects.automations.for(scope),
                execution,
              });
              const instances = await workflow.listInstances({ pageSize: 10 });
              expect(instances.instances, JSON.stringify(instances)).toHaveLength(2);
              const inline = instances.instances.find(
                (instance) => instance.id !== "saved-checker",
              );
              assert(inline);
              inlineInstanceId = inline.id;
              for (const instance of instances.instances) {
                assert.equal(instance.details.status, "waiting");
                const response = await runtime.objects.automations
                  .for(scope)
                  .http.fetchAuthorized(
                    new Request(
                      `https://automations.test/api/workflows/codemode-script/instances/${instance.id}`,
                    ),
                    { execution, propagationContext: null },
                  );
                assert.equal(response.status, 200, await response.clone().text());
                const stored = await response.json<{ meta: { params: CodemodeWorkflowParams } }>();
                expect(stored.meta.params.execution).toMatchObject({
                  scopeRestriction: null,
                  scope,
                  actors: execution.actors,
                  billingOrganizationId: "org-1",
                });
                expect(stored.meta.params.execution).not.toHaveProperty("userAuthority");
              }
              const directory = await (
                await request(runtime, execution, "/sessions", null)
              ).json<{ sessions: PiAgentConfig[] }>();
              expect(directory.sessions).toHaveLength(3);
              classifiers = directory.sessions.filter(
                (session) => session.sessionId !== config.sessionId,
              );
              expect(new Set(classifiers.map((session) => session.name))).toEqual(
                new Set(["Inline classifier", "Saved classifier"]),
              );
              for (const classifier of classifiers) {
                expect(classifier).toMatchObject({
                  scopeRestriction: null,
                  scope,
                  billingOrganizationId: "org-1",
                  actors: execution.actors,
                });
              }
              const period = new Date(runtime.now()).toISOString().slice(0, 7);
              const trackers = await runtime.objects.billing
                .forOrg("org-1")
                .commands.getTrackers({ scope, period, pageSize: 100 });
              const tokens = trackers.trackers.find(
                (tracker) => tracker.meter === "ai.tokens.total",
              );
              assert(tokens);
              tokensBeforeResume = { quantity: tokens.quantity, eventCount: tokens.eventCount };
            },
          ),
          runner.restartObject({ binding: "AUTOMATIONS", scope }),
          ...(revokeBillingAccess
            ? [when.auth.removeMember({ orgId: "org-1", userId: "member" })]
            : []),
          then.assert("resumed classifiers use current billing authority", async ({ runtime }) => {
            const workflow = createRouteBackedAutomationWorkflowRuntime({
              object: runtime.objects.automations.for(scope),
              execution,
            });
            for (const instanceId of [inlineInstanceId, "saved-checker"]) {
              await workflow.sendEvent({
                instanceId,
                type: "sentence",
                payload: { sentence: "hello" },
              });
            }
            await runtime.drain();
            for (const instanceId of [inlineInstanceId, "saved-checker"]) {
              assert.equal((await workflow.getInstance({ instanceId })).details.status, "complete");
            }
            for (const classifier of classifiers) {
              const instanceId =
                classifier.name === "Inline classifier" ? inlineInstanceId : "saved-checker";
              const submission = await (
                await request(
                  runtime,
                  execution,
                  `/sessions/${classifier.sessionId}/submissions/${instanceId}:sentence`,
                  null,
                )
              ).json();
              expect(submission).toMatchObject({
                status: revokeBillingAccess ? "unanswered" : "done",
              });
              const transcript = await view(runtime, execution, classifier);
              if (revokeBillingAccess) {
                expect(JSON.stringify(transcript.entries)).not.toContain("Not naughty.");
              } else {
                expect(JSON.stringify(transcript.entries)).toContain("Not naughty.");
              }
            }
            expect(classifierCalls).toBe(revokeBillingAccess ? 0 : 2);
            const period = new Date(runtime.now()).toISOString().slice(0, 7);
            const trackers = await runtime.objects.billing
              .forOrg("org-1")
              .commands.getTrackers({ scope, period, pageSize: 100 });
            const tokens = trackers.trackers.find((tracker) => tracker.meter === "ai.tokens.total");
            assert(tokens);
            if (revokeBillingAccess) {
              expect({ quantity: tokens.quantity, eventCount: tokens.eventCount }).toEqual(
                tokensBeforeResume,
              );
            } else {
              expect(Number(tokens.quantity)).toBeGreaterThan(Number(tokensBeforeResume.quantity));
              expect(Number(tokens.eventCount)).toBe(Number(tokensBeforeResume.eventCount) + 2);
            }
          }),
        ],
      }),
    );
  });
}

test("durable Pi restores scoped tools and reports interrupted codemode without repeating its mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-codemode-recovery-"));
  const snapshot = path.join(directory, "interrupted.sqlite");
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "codemode-recovery" },
  });
  let source: {
    agent: InMemoryPiObject;
    options: ConstructorParameters<typeof InMemoryPiObject>[0];
  } | null = null;
  const objectOverrides: LocalBackofficeObjects = {
    PI: ({ state, runtime, piAgentIdFromConfig, nowEpochMs }) => {
      const database = openNodeSqliteDatabase(":memory:");
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("execCodeMode", {
              code: `async () => {
          const count = Number(await state.readFile({ path: "/workspace/codemode-effects.txt" })) + 1;
          await state.writeFile({ path: "/workspace/codemode-effects.txt", content: String(count) });
          return { count };
        }`,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Original process completed."),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "capture-codemode-crash-point",
          hooks: [
            hook(ToolTask, {
              afterTool: async (call) => {
                if (call.name === "execCodeMode") {
                  // Capture real committed intent after the external mutation, before result settlement.
                  await (await database).run("VACUUM INTO ?", snapshot);
                }
              },
            }),
          ],
        }),
      );
      const options = {
        state,
        runtime,
        options: { models, registry },
        openStorage: async () => await SqliteStorage.open(await database),
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      };
      const agent = new InMemoryPiObject(options);
      source = { agent, options };
      return agent;
    },
  };
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "durable Pi interrupted codemode recovery",
        options: { drain: false },
        objects: { ...scenarioObjects, ...objectOverrides },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.organization.exists({ id: "org-1" }),
          given.codemode.writeFile({
            orgId: "org-1",
            path: "/workspace/codemode-effects.txt",
            content: "0",
          }),
        ],
        steps: ({ then }) => [
          then.assert(
            "restore the actual SQLite crash point with fresh runtime context",
            async ({ runtime }) => {
              const config = await createAgent(runtime, execution);
              await prompt(runtime, execution, config);
              await runtime.drain();
              expect(JSON.stringify((await view(runtime, execution, config)).entries)).toContain(
                "Original process completed.",
              );
              const captured = source;
              if (captured === null) {
                throw new Error("The scenario did not provision a Pi agent.");
              }
              await captured.agent.close();
              const faux = fauxProvider();
              faux.setResponses([
                (context) => {
                  const result = context.messages
                    .filter((message) => message.role === "toolResult")
                    .at(-1);
                  assert.equal(result?.isError, true, JSON.stringify(result));
                  expect(JSON.stringify(result)).toContain(
                    "Tool execCodeMode was interrupted and may have partially run",
                  );
                  return fauxAssistantMessage(
                    [fauxToolCall("read", { path: "/workspace/codemode-effects.txt" })],
                    { stopReason: "toolUse" },
                  );
                },
                (context) => {
                  const result = context.messages
                    .filter((message) => message.role === "toolResult")
                    .at(-1);
                  assert.equal(result?.isError, false, JSON.stringify(result));
                  expect(result?.content).toEqual([{ type: "text", text: "1" }]);
                  return fauxAssistantMessage("Recovered with exactly one mutation.");
                },
              ]);
              const models = createModels();
              models.setProvider(faux.provider);
              const restored = new InMemoryPiObject({
                ...captured.options,
                options: { ...captured.options.options, models },
                openStorage: async () => await openNodeSqliteStorage(snapshot),
              });
              try {
                await restored.alarm();
                const transcript = (await restored.getView(config)) as ConversationView;
                expect(JSON.stringify(transcript.entries)).toContain(
                  "Recovered with exactly one mutation.",
                );
                expect(transcript.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(
                  1,
                );
              } finally {
                await restored.close();
              }
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable Pi scoped codemode handles select a different manager instead of reusing the parent directory", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "scope-scenario" },
  });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi scoped child directory",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          fauxAssistantMessage(
            [
              fauxToolCall("execCodeMode", {
                code: `async () => {
        const user = context.user("org-1");
        return await user.pi.createSession({
          name: "User child",
          model: { provider: "faux", modelId: "faux-1" },
        });
      }`,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          (context) => {
            const result = context.messages.find((message) => message.role === "toolResult");
            assert(result?.role === "toolResult");
            expect(result.isError, JSON.stringify(result)).toBe(false);
            return fauxAssistantMessage("Child created in the user scope.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      steps: ({ then }) => [
        then.assert("scope changes rebuild the manager runtime", async ({ runtime }) => {
          const config = await createAgent(runtime, execution);
          await prompt(runtime, execution, config);
          await runtime.drain();
          const transcript = await view(runtime, execution, config);
          expect(JSON.stringify(transcript.entries)).toContain("Child created in the user scope.");
          const other = { ...execution, scope: { kind: "user", userId: "org-1" } as const };
          const parentDirectory = await (
            await request(runtime, execution, "/sessions", null)
          ).json<{ sessions: PiAgentConfig[] }>();
          const childDirectory = await (
            await request(runtime, other, "/sessions", null)
          ).json<{ sessions: PiAgentConfig[] }>();
          expect(parentDirectory.sessions).toHaveLength(1);
          expect(childDirectory.sessions).toHaveLength(1);
          expect(childDirectory.sessions[0]).toMatchObject({
            name: "User child",
            scopeRestriction: null,
            scope: other.scope,
            actors: execution.actors,
          });
        }),
      ],
    }),
  );
});

test("Cloudflare backend analytics delivers verified outcomes and Pi usage without conversation content", async () => {
  type IngestedEvent = {
    event: string;
    distinct_id: string;
    uuid: string;
    properties: Record<string, unknown>;
  };
  const received: IngestedEvent[] = [];
  let receiverStatus = 200;
  const receiver = createServer((incoming, response) => {
    incoming.setEncoding("utf8");
    let body = "";
    incoming.on("data", (chunk: string) => {
      body += chunk;
    });
    incoming.on("end", () => {
      // This local endpoint receives the real SDK's authoritative batch wire format.
      const batch = JSON.parse(body) as { batch: IngestedEvent[] };
      if (receiverStatus === 200) {
        received.push(...batch.batch);
      }
      response.writeHead(receiverStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: receiverStatus === 200 ? 1 : 0 }));
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  assert(address !== null && typeof address !== "string");
  const client = new PostHog("phc_scenario", {
    host: `http://127.0.0.1:${address.port}`,
    flushAt: 100,
    flushInterval: 0,
    disableCompression: true,
    disableGeoip: true,
    fetchRetryCount: 0,
    requestTimeout: 1_000,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-posthog-"));
  const deliveries: Promise<unknown>[] = [];
  let config: PiAgentConfig | null = null;
  const objectOverrides: LocalBackofficeObjects = {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("PRIVATE_ASSISTANT_OUTPUT")]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      registry.install(
        createPiPostHogExtension({
          getConfig: async () => {
            assert(config);
            return config;
          },
          capture: async (event) => {
            client.capture(event);
          },
        }),
      );
      return new InMemoryPiObject({
        state,
        runtime,
        options: { models, registry },
        openStorage: openPiSessionStore,
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      });
    },
  };

  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "PostHog captures SQLite-backed server outcomes and durable generations",
        options: { drain: false, sqliteDataDirectory: directory },
        objects: { ...scenarioObjects, ...objectOverrides },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_INVITATIONS_ENABLED: "false" },
        vars: () => ({ session: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "analytics@example.test", captureSessionCookieAs: "session" }),
          then.assert(
            "only successful operations reach the real ingestion endpoint",
            async (ctx) => {
              const origin = "https://backoffice.example";
              const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
                new Request(`${origin}/api/auth/backoffice-token`, {
                  method: "POST",
                  headers: { cookie: ctx.vars.session, origin, "content-type": "application/json" },
                  body: JSON.stringify({ selection: "preferred", organizationId: null }),
                }),
              );
              assert(exchange.ok, await exchange.clone().text());
              const { organization } = issueBackofficeTokenResultSchema.parse(
                await exchange.json(),
              );
              assert(organization);
              const scope = { kind: "org" as const, orgId: organization.id };
              const cookie = exchange.headers
                .getSetCookie()
                .map((value) => value.split(";", 1)[0])
                .join("; ");
              const authenticatedRequest = new Request(`${origin}/backoffice/sessions`, {
                method: "POST",
                headers: { cookie },
              });
              const context = createBackofficeRouterContextProvider(authenticatedRequest, {
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                env: ctx.runtime.env as unknown as CloudflareEnv,
                ctx: {} as ExecutionContext,
              });
              context.set(BackofficePostHogContext, {
                client,
                requestId: "request-scenario",
                userId: null,
                capturedErrors: new WeakSet<Error>(),
                waitUntil: (promise) => {
                  deliveries.push(promise);
                },
              });
              const created = await createPiManagerSession(authenticatedRequest, context, scope, {
                name: "PRIVATE_SESSION_NAME",
                model: { provider: "faux", modelId: "faux-1" },
                instructions: "PRIVATE_SYSTEM_INSTRUCTIONS",
                billingOrganizationId: organization.id,
              });
              assert(created.session, created.error ?? "No session created");
              config = created.session;
              const principal = config.actors.principal;
              assert(principal?.scope === "internal" && principal.type === "user");
              const admission = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                config.sessionId,
                {
                  requestId: "accepted-prompt",
                  content: "PRIVATE_USER_PROMPT",
                  whenBusy: "reject",
                },
              );
              expect(admission).toEqual({ requestId: "accepted-prompt", error: null });
              const rejected = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "missing-session",
                {
                  requestId: "rejected-prompt",
                  content: "PRIVATE_REJECTED_PROMPT",
                  whenBusy: "reject",
                },
              );
              assert(rejected.error !== null);
              await ctx.runtime.drain();
              await shutdownCloudflarePostHog(client);
              expect(received.filter((event) => event.event === "session_created")).toHaveLength(1);
              expect(
                received.filter((event) => event.event === "session_prompt_admitted"),
              ).toHaveLength(1);
              const generation = received.filter((event) => event.event === "$ai_generation");
              expect(generation).toHaveLength(1);
              expect(generation[0].distinct_id).toBe(principal.id);
              expect(generation[0].uuid).toBe(generation[0].properties.$ai_span_id);
              expect(generation[0].properties).toMatchObject({
                session_id: config.sessionId,
                $ai_session_id: config.sessionId,
                $ai_provider: "faux",
                $ai_model: "faux-1",
                $ai_is_error: false,
                $process_person_profile: false,
              });
              for (const marker of [
                "PRIVATE_SESSION_NAME",
                "PRIVATE_SYSTEM_INSTRUCTIONS",
                "PRIVATE_USER_PROMPT",
                "PRIVATE_ASSISTANT_OUTPUT",
                "PRIVATE_REJECTED_PROMPT",
              ]) {
                expect(JSON.stringify(received)).not.toContain(marker);
              }

              // Streaming failures can arrive after the request batch has already shut down.
              const lateError = new Error("Late rendering failure");
              captureBackofficeServerException(context, lateError);
              captureBackofficeServerException(context, lateError);
              await Promise.all(deliveries);
              const exceptions = received.filter((event) => event.event === "$exception");
              expect(exceptions).toHaveLength(1);
              expect(exceptions[0].distinct_id).toBe(principal.id);

              // An unavailable analytics service must not roll back or hide a successful server operation.
              receiverStatus = 503;
              const failedDeliveryClient = new PostHog("phc_scenario", {
                host: `http://127.0.0.1:${address.port}`,
                flushAt: 100,
                flushInterval: 0,
                disableCompression: true,
                fetchRetryCount: 0,
              });
              const analytics = context.get(BackofficePostHogContext);
              assert(analytics);
              context.set(BackofficePostHogContext, { ...analytics, client: failedDeliveryClient });
              const second = await createPiManagerSession(authenticatedRequest, context, scope, {
                name: null,
                model: { provider: "faux", modelId: "faux-1" },
                instructions: "",
                billingOrganizationId: organization.id,
              });
              assert(second.session, second.error ?? "No second session created");
              await shutdownCloudflarePostHog(failedDeliveryClient);
              expect(second.error).toBeNull();
              const persisted = await fetchPiManagerSessions(authenticatedRequest, context, scope);
              expect(persisted.sessions.map((session) => session.sessionId)).toContain(
                second.session.sessionId,
              );
              expect(received.filter((event) => event.event === "session_created")).toHaveLength(1);
            },
          ),
        ],
      }),
    );
  } finally {
    await Promise.all(deliveries);
    await shutdownCloudflarePostHog(client);
    receiver.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      receiver.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
