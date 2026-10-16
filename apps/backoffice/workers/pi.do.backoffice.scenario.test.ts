import { assert, expect, test, vi } from "vitest";

import type { PiAgentConfig, PiManagerAgentDirectory } from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

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

import type { Context, Message } from "@earendil-works/pi-ai";
import {
  defineExtension,
  hook,
  ToolTask,
  type ConversationView,
  type HarnessSettings,
} from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeRequestExecution,
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { issueBackofficeTokenResultSchema } from "@/fragno/auth/contracts";
import type { CodemodeWorkflowParams } from "@/fragno/automation/engine/codemode-invocation";
import { createRouteBackedAutomationRouterRuntime } from "@/fragno/automation/routing-route-runtime";
import {
  backofficeFiles,
  defineBackofficeScenario,
  runBackofficeScenario,
} from "@/fragno/automation/scenario";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import { piAgentObjectName } from "@/fragno/pi/agent/pi-agent-contract";
import { createPiPostHogExtension } from "@/fragno/pi/extensions/posthog/posthog-extension";
import { BackofficePostHogContext, captureBackofficeServerException } from "@/posthog.server";
import { fetchPiManagerAgents, submitPiManagerPrompt } from "@/routes/backoffice/agents/data";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { shutdownCloudflarePostHog } from "./lib/cloudflare-posthog";
import { createScriptedPiAgentDependencies } from "./pi-durable-scenario.test-support";
import { InMemoryPiObject } from "./pi.do";

const scenarioObjects = allLocalObjects;

const PI_SCENARIO_AVAILABLE_MODELS = [
  { provider: "faux", modelId: "faux-1", label: "Faux 1", contextWindow: 128_000 },
] as const;

/** Every agent object gets its own copy of the scripted responses. */
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
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          ...(settings ? { settings } : {}),
        },
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
  method: "GET" | "POST" | "PUT" = body === null ? "GET" : "POST",
) {
  return await runtime.objects.piManager.for(execution.scope).http.fetchAuthorized(
    new Request(`https://pi-manager.test/api/pi-manager${route}`, {
      method,
      headers: body === null ? {} : { "content-type": "application/json" },
      body: body === null ? undefined : JSON.stringify(body),
    }),
    { execution, propagationContext: null },
  );
}

async function prompt(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  input: {
    agentName?: string;
    requestId?: string;
    content?: string;
    billingOrganizationId?: string | null;
  } = {},
) {
  const {
    agentName = "assistant",
    requestId = "backoffice-prompt",
    content = "Use the Backoffice context.",
    billingOrganizationId = null,
  } = input;
  const submitted = await request(runtime, execution, `/agents/${agentName}/prompts`, {
    requestId,
    content,
    billingOrganizationId,
  });
  assert.equal(submitted.status, 202, await submitted.clone().text());
}

async function view(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  agentName = "assistant",
) {
  const response = await request(runtime, execution, `/agents/${agentName}/view`, null);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json<ConversationView>();
}

async function submission(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  requestId: string,
  agentName = "assistant",
) {
  return await (
    await request(runtime, execution, `/agents/${agentName}/submissions/${requestId}`, null)
  ).json<{ status: string } | { code: string }>();
}

function lastUserText(context: Context) {
  const content = context.messages.filter((message) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

function userTexts(view: ConversationView) {
  return view.entries.filter((entry) => entry.kind === "pi.user");
}

function toolResults(context: Context) {
  return context.messages.filter(
    (message): message is Extract<Message, { role: "toolResult" }> => message.role === "toolResult",
  );
}

test("durable Pi runs a workspace agent with its instructions, scoped skills, Backoffice tools, and other agents", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "durable-tool-scenario" },
  });
  // One dispatcher serves the researcher's turn and the assistant agent prompted from codemode.
  const respond: FauxResponseStep = (context) => {
    const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
    const lastUser = lastUserText(context);
    if (lastUser === "First other-agent prompt") {
      return fauxAssistantMessage("First other-agent answer.");
    }
    if (lastUser === "Second other-agent prompt") {
      return fauxAssistantMessage("Second other-agent answer.");
    }
    const results = toolResults(context);
    if (results.length === 0) {
      expect(system).toContain("Keep the researcher instruction.");
      expect(system).toContain(
        "You are the Backoffice agent `researcher`: that is your `agentName` in `pi.agent.*` tools",
      );
      expect(system.match(/# Backoffice System Guidance/g)).toHaveLength(1);
      expect(system).toContain("Scoped durable skill");
      expect(system).toContain("/workspace/skills/durable/SKILL.md");
      expect(system).toContain("/static/skills/");
      expect(system).toContain("/static/codemode/");
      expect(
        context.messages
          .filter((message) => message.role === "system")
          .flatMap((message) => message.toolsAdded ?? [])
          .map((tool) => tool.name),
      ).toEqual(expect.arrayContaining(["read", "search", "execCodeMode"]));
      return fauxAssistantMessage(
        [
          fauxToolCall("read", { path: "/workspace/durable-notes.txt", offset: 2, limit: 1 }),
          fauxToolCall("search", {
            keywords: ["Durable marker"],
            glob: "/workspace/durable-notes.txt",
          }),
          fauxToolCall("execCodeMode", {
            code: `async () => {
          await state.writeFile({ path: "/workspace/durable-result.txt", content: "executed through Backoffice" });
          const first = await pi.runPrompt({ agentName: "assistant", content: "First other-agent prompt" });
          const second = await context.current.pi.runPrompt({ agentName: "assistant", content: "Second other-agent prompt" });
          const directory = await pi.listAgents({});
          const assistant = await pi.getAgent({ agentName: "assistant" });
          return {
            first: first.assistantText,
            second: second.assistantText,
            agents: directory.agents.map(agent => agent.agentName),
            inputs: assistant.view.entries.filter(entry => entry.kind === "pi.user").length,
          };
        }`,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    expect(results).toHaveLength(3);
    assert(
      results.every((result) => !result.isError),
      JSON.stringify(results),
    );
    expect(JSON.stringify(results)).toContain("Durable marker");
    expect(results.find((result) => result.toolName === "execCodeMode")?.details).toMatchObject({
      result: {
        first: "First other-agent answer.",
        second: "Second other-agent answer.",
        agents: ["assistant", "researcher"],
        inputs: 2,
      },
    });
    return fauxAssistantMessage("Backoffice tool run finished.");
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi Backoffice environment and tools",
      options: { drain: false },
      objects: { ...scenarioObjects, ...scriptedAgents([respond, respond, respond, respond]) },
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
        then.assert("run and settle a real Backoffice agent turn", async ({ runtime }) => {
          const defined = await request(runtime, execution, "/agents", {
            agentName: "researcher",
            description: "Researches the workspace.",
            model: null,
            permissions: ["*"],
            instructions: "Keep the researcher instruction.",
            managedBy: null,
          });
          assert.equal(defined.status, 201, await defined.clone().text());
          await prompt(runtime, execution, { agentName: "researcher" });
          await runtime.drain();
          const transcript = await view(runtime, execution, "researcher");
          expect(JSON.stringify(transcript.entries)).toContain("Backoffice tool run finished.");
          const directory = await (
            await request(runtime, execution, "/agents", null)
          ).json<PiManagerAgentDirectory>();
          expect(
            directory.agents.map((agent) => [agent.agentName, agent.provisioning !== null]),
          ).toEqual([
            ["assistant", true],
            ["researcher", true],
          ]);
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

test("durable Pi lists Marketplace-installed skills and finds them by any keyword", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "durable-search-scenario" },
  });
  const skillPath = "/workspace/slack-setup/skills/slack-setup/SKILL.md";
  const objectOverrides = scriptedAgents([
    (context) => {
      expect(
        JSON.stringify(context.messages.filter((message) => message.role === "system")),
      ).toContain(skillPath);
      return fauxAssistantMessage(
        [
          fauxToolCall("search", {
            keywords: ["Slack integration", "createConnection"],
            glob: "/workspace/**",
          }),
          fauxToolCall("search", { keywords: ["no-such-keyword"] }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      const [found, missing] = context.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolName === "search"
          ? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
          : [],
      );
      expect(found).toContain(`${skillPath}\n`);
      expect(found).toContain("Connect the Slack integration");
      expect(found).toContain("await api.createConnection");
      expect(found).not.toContain("noise.md");
      expect(found).not.toContain("cursor");
      expect(missing).toBe('No matches for "no-such-keyword" in **.');
      return fauxAssistantMessage("Search finished.");
    },
  ]);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi skill discovery and keyword search",
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1" }),
        // Sorted before the skill, this file floods the first keyword's index term without ever
        // matching the keyword, which used to end the first page empty.
        given.codemode.writeFile({
          orgId: "org-1",
          path: "/workspace/a-noise.md",
          content: "integration\n".repeat(80),
        }),
        given.codemode.writeFile({
          orgId: "org-1",
          path: skillPath,
          content: [
            "---",
            "name: slack-setup",
            "description: Set up Slack bot messages and Events API webhooks.",
            "---",
            "# Slack setup",
            "Connect the Slack integration with a bot token.",
            'await api.createConnection({ slug: "slack" });',
          ].join("\n"),
        }),
      ],
      steps: ({ then }) => [
        then.assert("the agent finds the installed skill", async ({ runtime }) => {
          await prompt(runtime, execution);
          await runtime.drain();
          const transcript = await view(runtime, execution);
          expect(JSON.stringify(transcript.entries)).toContain("Search finished.");
        }),
      ],
    }),
  );
});

test("an agent's definition narrows every turn and an edited definition applies from the next turn", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "narrowing-scenario" },
  });
  const reader = {
    description: "Reads the workspace.",
    model: null,
    permissions: ["upload.read"],
    instructions: "",
    managedBy: null,
  };
  const storeWrite = fauxAssistantMessage(
    [
      fauxToolCall("execCodeMode", {
        code: `async () => await store.set({ key: "reader/result", value: "written" })`,
      }),
    ],
    { stopReason: "toolUse" },
  );
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi definition narrowing",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          storeWrite,
          (context) => {
            const result = toolResults(context).at(-1);
            assert.equal(result?.isError, true, JSON.stringify(result));
            expect(JSON.stringify(result)).toContain(
              "Agent 'reader' is not granted store.modify; its definition grants: upload.read.",
            );
            return fauxAssistantMessage("The reader may not write the store.");
          },
          storeWrite,
          (context) => {
            const result = toolResults(context).at(-1);
            assert.equal(result?.isError, false, JSON.stringify(result));
            return fauxAssistantMessage("The widened reader wrote the store.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert(
          "an unrestricted principal is narrowed to the definition",
          async ({ runtime }) => {
            const defined = await request(runtime, execution, "/agents", {
              agentName: "reader",
              ...reader,
            });
            assert.equal(defined.status, 201, await defined.clone().text());
            await prompt(runtime, execution, { agentName: "reader", requestId: "narrowed" });
            await runtime.drain();
            expect(await submission(runtime, execution, "narrowed", "reader")).toMatchObject({
              status: "done",
            });
          },
        ),
        then.store.missing({ orgId: "org-1", key: "reader/result" }),
        then.assert("the edited definition governs the next turn", async ({ runtime }) => {
          const widened = await request(
            runtime,
            execution,
            "/agents/reader",
            { ...reader, description: "Reads and writes.", permissions: ["*"] },
            "PUT",
          );
          assert.equal(widened.status, 200, await widened.clone().text());
          await prompt(runtime, execution, { agentName: "reader", requestId: "widened" });
          await runtime.drain();
          expect(JSON.stringify((await view(runtime, execution, "reader")).entries)).toContain(
            "The widened reader wrote the store.",
          );
        }),
        then.store.entry({ orgId: "org-1", key: "reader/result", value: "written" }),
      ],
    }),
  );
});

for (const revocation of ["restricted", "disabled", "deleted"] as const) {
  test(`durable Pi runs each turn as its own prompter after a linked-user route is ${revocation}`, async () => {
    const scope = { kind: "org", orgId: "org-1" } as const;
    const execution = createBackofficeUserExecution({ scope, userId: "member" });
    const workflowPath = "/workspace/automations/delegated-pi.workflow.js";
    let modelCalls = 0;
    const telegramEvent = (id: string) => ({
      id,
      scopeRestriction: null,
      scope,
      source: "telegram",
      eventType: "message.received",
      occurredAt: "2026-10-04T16:23:00.000Z",
      payload: { chatId: "1001", messageId: id, fromUserId: "1001", text: "Hello" },
      actors: {
        initiator: {
          scope: "external" as const,
          source: "telegram",
          type: "chat",
          id: "1001",
          role: "initiator" as const,
        },
        principal: null,
        delegation: [],
      },
      subject: { orgId: "org-1" },
    });
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `durable Pi turn authority after the route is ${revocation}`,
        // The restricted route's later workflow fails because it may no longer prompt the agent.
        options: { drain: false, allowErroredWorkflows: revocation === "restricted" },
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
              const result = toolResults(context).at(-1);
              expect(result?.isError, JSON.stringify(result)).toBe(false);
              return fauxAssistantMessage("The linked-user turn answered.");
            },
            () => {
              modelCalls += 1;
              return fauxAssistantMessage("The member's own turn answered.");
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
              return await step.do("run linked-user turn", async () => await pi.runPrompt({
                agentName: "assistant",
                requestId: event.instanceId + ":prompt",
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
          when.automation.ingestEvent(telegramEvent("linked-pi-message")),
          then.assert("the route's turn runs as the linked user", async ({ runtime }) => {
            await runtime.drain();
            const transcript = await view(runtime, execution);
            expect(JSON.stringify(transcript.entries)).toContain("The linked-user turn answered.");
            expect(modelCalls).toBe(2);
          }),
          then.store.entry({ orgId: "org-1", key: "linked-pi/result", value: "written" }),
          then.kernel.action({
            operation: BACKOFFICE_PERMISSION.store.modify,
            scope,
            actors: {
              initiator: telegramEvent("linked-pi-message").actors.initiator,
              principal: { scope: "internal", type: "user", id: "member", role: "principal" },
              delegation: [
                {
                  scope: "internal",
                  type: "automation",
                  id: "automation-route:telegram-pi-linking",
                  role: "delegate",
                },
                piAgentActor(scope, "assistant"),
              ],
            },
          }),
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
            "the member's own prompt runs without the route's authority",
            async ({ runtime }) => {
              await prompt(runtime, execution, { requestId: "member-prompt" });
              await runtime.drain();
              expect(await submission(runtime, execution, "member-prompt")).toMatchObject({
                status: "done",
              });
              expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
                "The member's own turn answered.",
              );
              expect(modelCalls).toBe(3);
            },
          ),
          ...(revocation === "restricted"
            ? [
                when.automation.ingestEvent(telegramEvent("restricted-pi-message")),
                then.assert(
                  "a later route turn has only the route's current grants",
                  async ({ runtime }) => {
                    await runtime.drain();
                    // Without pi.modify the route cannot even admit a turn.
                    expect(
                      await submission(
                        runtime,
                        execution,
                        "linked-pi-restricted-pi-message:prompt",
                      ),
                    ).toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
                    const workflow = createRouteBackedAutomationWorkflowRuntime({
                      object: runtime.objects.automations.for(scope),
                      execution: createBackofficeUserExecution({ scope, userId: "owner" }),
                    });
                    assert(
                      (
                        await workflow.getInstance({
                          instanceId: "linked-pi-restricted-pi-message",
                        })
                      ).details.status === "errored",
                    );
                    expect(userTexts(await view(runtime, execution))).toHaveLength(2);
                    expect(modelCalls).toBe(3);
                  },
                ),
              ]
            : []),
        ],
      }),
    );
  });
}

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
          await prompt(runtime, execution);
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

          const compacted = await request(runtime, execution, "/agents/assistant/compact", {
            instructions: "Preserve the billed answer.",
          });
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

test("a personal agent keeps its first turn's billing owner and rechecks current access before every generation", async () => {
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
            return fauxAssistantMessage("Billed to the organization.");
          },
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
        then.assert("the first turn chooses an authorized billing owner", async ({ runtime }) => {
          const missingOwner = await request(runtime, execution, "/agents/assistant/prompts", {
            requestId: "unbilled",
            content: "Answer.",
            billingOrganizationId: null,
          });
          assert.equal(missingOwner.status, 400, await missingOwner.clone().text());
          const foreignOwner = await request(runtime, execution, "/agents/assistant/prompts", {
            requestId: "foreign",
            content: "Answer.",
            billingOrganizationId: "foreign-org",
          });
          assert.equal(foreignOwner.status, 403, await foreignOwner.clone().text());
          await prompt(runtime, execution, { requestId: "billed", billingOrganizationId: "org-1" });
          await runtime.drain();
          expect(await submission(runtime, execution, "billed")).toMatchObject({ status: "done" });
          const agent = await (await request(runtime, execution, "/agents/assistant", null)).json();
          expect(agent).toMatchObject({ provisioning: { billingOrganizationId: "org-1" } });
          expect(modelCalls).toBe(1);
        }),
        when.auth.removeMember({ orgId: "org-1", userId: "member" }),
        then.assert(
          "the still-valid JWT cannot authorize a deferred model call after revocation",
          async ({ runtime }) => {
            await prompt(runtime, execution, { requestId: "revoked" });
            await runtime.drain();
            expect(await submission(runtime, execution, "revoked")).toMatchObject({
              status: "unanswered",
            });
            expect(modelCalls).toBe(1);
            const transcript = await view(runtime, execution);
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
      await step.waitForEvent("wait for sentence", { type: "sentence" });
      return await step.do("submit sentence", async () => await ${promptOperation}({
        agentName: "assistant",
        requestId: event.instanceId + ":sentence",
        content: "Classify this sentence",
      }));
    });`;
    const workflowCode = `defineWorkflow({ name: "inline-sentence-checker" }, async (event, step) => {
      await step.do("start nested workflow", async () => await context.current.workflow.createInstance({
        path: "/workspace/automations/saved-sentence-checker.workflow.js",
        instanceId: "saved-checker",
      }));
      await step.waitForEvent("wait for sentence", { type: "sentence" });
      return await step.do("submit sentence", async () => await ${promptOperation}({
        agentName: "assistant",
        requestId: event.instanceId + ":sentence",
        content: "Classify this sentence",
      }));
    });`;
    let inlineInstanceId: string;
    let tokensBeforeResume: { quantity: string; eventCount: string };
    let classifierCalls = 0;
    const respond: FauxResponseStep = (context) => {
      if (lastUserText(context) === "Classify this sentence") {
        classifierCalls += 1;
        return fauxAssistantMessage("Not naughty.");
      }
      const results = toolResults(context);
      if (results.length === 0) {
        return fauxAssistantMessage([fauxToolCall("execCodeMode", { code: workflowCode })], {
          stopReason: "toolUse",
        });
      }
      expect(results).toHaveLength(1);
      expect(results[0]?.isError, JSON.stringify(results)).toBe(false);
      return fauxAssistantMessage("Sentence checker is waiting.");
    };
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `inherited workflow billing${revokeBillingAccess ? " after revocation" : ""}`,
        files: backofficeFiles.workspaceStarter({
          "automations/saved-sentence-checker.workflow.js": savedWorkflowCode,
        }),
        options: { drain: false },
        // Beyond the classifications, the agent hears back when its workflow ends.
        objects: {
          ...scenarioObjects,
          ...scriptedAgents(Array.from({ length: 5 }, () => respond)),
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
            "inline and nested workflows persist the turn's billing selection and actors",
            async ({ runtime }) => {
              await prompt(runtime, execution, { billingOrganizationId: "org-1" });
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
                  actors: {
                    ...execution.actors,
                    delegation: [...execution.actors.delegation, piAgentActor(scope, "assistant")],
                  },
                  billingOrganizationId: "org-1",
                });
                expect(stored.meta.params.execution).not.toHaveProperty("userAuthority");
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
          then.assert(
            "resumed workflow turns use current billing authority",
            async ({ runtime }) => {
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
                // A workflow that lost its billing organization cannot admit the turn at all.
                assert.equal(
                  (await workflow.getInstance({ instanceId })).details.status,
                  revokeBillingAccess ? "errored" : "complete",
                );
                expect(
                  await submission(runtime, execution, `${instanceId}:sentence`),
                ).toMatchObject(
                  revokeBillingAccess ? { code: "SUBMISSION_NOT_FOUND" } : { status: "done" },
                );
              }
              const transcript = JSON.stringify((await view(runtime, execution)).entries);
              if (revokeBillingAccess) {
                expect(transcript).not.toContain("Not naughty.");
              } else {
                expect(transcript).toContain("Not naughty.");
              }
              expect(classifierCalls).toBe(revokeBillingAccess ? 0 : 2);
              const period = new Date(runtime.now()).toISOString().slice(0, 7);
              const trackers = await runtime.objects.billing
                .forOrg("org-1")
                .commands.getTrackers({ scope, period, pageSize: 100 });
              const tokens = trackers.trackers.find(
                (tracker) => tracker.meter === "ai.tokens.total",
              );
              assert(tokens);
              if (revokeBillingAccess) {
                expect({ quantity: tokens.quantity, eventCount: tokens.eventCount }).toEqual(
                  tokensBeforeResume,
                );
              } else {
                expect(Number(tokens.quantity)).toBeGreaterThan(
                  Number(tokensBeforeResume.quantity),
                );
                expect(Number(tokens.eventCount)).toBeGreaterThan(
                  Number(tokensBeforeResume.eventCount),
                );
              }
            },
          ),
        ],
      }),
    );
  });
}

/** The events an agent was notified of, as the model reads them. */
function heardEvents(context: Context) {
  return context.messages.flatMap((message) => {
    if (message.role !== "user" || typeof message.content !== "string") {
      return [];
    }
    const match = /^<backoffice-event ([^>]*)>\n(.*)\n<\/backoffice-event>$/su.exec(
      message.content,
    );
    if (!match) {
      return [];
    }
    const data = JSON.parse(match[2]) as {
      subject: { workflowName: string; instanceId: string };
      payload: Record<string, unknown>;
    };
    return [{ attributes: match[1], ...data }];
  });
}

test("an agent hears back from the workflow it starts when it ends", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "workflow-reply-scenario" },
  });
  const workflowCode = `defineWorkflow({ name: "approval-checker" }, async (event, step) => {
    const approval = await step.waitForEvent("wait for approval", { type: "approval" });
    return { approved: approval.payload.approved };
  });`;
  let instanceId = "";
  const heard: Array<ReturnType<typeof heardEvents>[number]> = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi workflow replies",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          fauxAssistantMessage([fauxToolCall("execCodeMode", { code: workflowCode })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("The approval checker is waiting for approval."),
          (context) => {
            const completed = heardEvents(context).at(-1);
            assert(completed);
            heard.push(completed);
            return fauxAssistantMessage("The approval checker approved.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      setup: ({ given }) => [given.organization.exists({ id: "org-1" })],
      steps: ({ then }) => [
        then.assert("the waiting workflow does not notify its agent", async ({ runtime }) => {
          await prompt(runtime, execution, { content: "Check the approval." });
          await runtime.drain();
          const workflow = createRouteBackedAutomationWorkflowRuntime({
            object: runtime.objects.automations.forOrg("org-1"),
            execution,
          });
          const [instance] = (await workflow.listInstances({ pageSize: 10 })).instances;
          assert(instance);
          instanceId = instance.id;
          assert.equal(instance.details.status, "waiting");
          expect(heard).toEqual([]);
        }),
        then.assert("the agent reads the result once it is approved", async ({ runtime }) => {
          const workflow = createRouteBackedAutomationWorkflowRuntime({
            object: runtime.objects.automations.forOrg("org-1"),
            execution,
          });
          await workflow.sendEvent({ instanceId, type: "approval", payload: { approved: true } });
          await runtime.drain();
          expect((await workflow.getInstance({ instanceId })).details).toMatchObject({
            status: "complete",
            output: { approved: true },
          });
          const transcript = JSON.stringify((await view(runtime, execution)).entries);
          expect(transcript).toContain("The approval checker approved.");
        }),
        then.assert("the notification names the workflow and carries no route", () => {
          expect(heard).toEqual([
            {
              attributes: expect.stringMatching(/source="workflows" type="instance.completed"/),
              subject: { workflowName: "approval-checker", instanceId },
              payload: { status: "complete", output: { approved: true }, error: null },
            },
          ]);
          expect(heard[0]?.attributes).not.toContain("route=");
        }),
      ],
    }),
  );
});

test("durable Pi restores scoped tools and reports interrupted codemode without repeating its mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-codemode-recovery-"));
  const snapshot = path.join(directory, "interrupted.sqlite");
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "codemode-recovery" },
  });
  const config: PiAgentConfig = {
    scope: execution.scope,
    agentName: "assistant",
    billingOrganizationId: "org-1",
  };
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
      const captureCrashPoint = defineExtension({
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
      });
      const options = {
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          extensions: () => [captureCrashPoint],
        },
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
              await prompt(runtime, execution);
              await runtime.drain();
              expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
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
                  const result = toolResults(context).at(-1);
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
                  const result = toolResults(context).at(-1);
                  assert.equal(result?.isError, false, JSON.stringify(result));
                  expect(result?.content).toEqual([{ type: "text", text: "1" }]);
                  return fauxAssistantMessage("Recovered with exactly one mutation.");
                },
              ]);
              const models = createModels();
              models.setProvider(faux.provider);
              const restored = new InMemoryPiObject({
                ...captured.options,
                dependencies: { ...captured.options.dependencies, models },
                openStorage: async () => await openNodeSqliteStorage(snapshot),
              });
              try {
                // The restored turn record is the only authority the recovered tools can use.
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

test("durable Pi scoped codemode handles prompt the selected scope's agent", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "scope-scenario" },
  });
  const userScope: BackofficeContextScope = { kind: "user", userId: "org-1" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi scoped agent",
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        ...scriptedAgents([
          (context) => {
            if (lastUserText(context) === "Hello from the organization agent.") {
              return fauxAssistantMessage("The personal agent answered.");
            }
            return fauxAssistantMessage(
              [
                fauxToolCall("execCodeMode", {
                  code: `async () => await context.user("org-1").pi.runPrompt({
                    agentName: "assistant",
                    content: "Hello from the organization agent.",
                  })`,
                }),
              ],
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            const result = toolResults(context).at(-1);
            assert(result?.role === "toolResult");
            expect(result.isError, JSON.stringify(result)).toBe(false);
            expect(JSON.stringify(result)).toContain("The personal agent answered.");
            return fauxAssistantMessage("Prompted the user-scoped agent.");
          },
        ]),
      },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      steps: ({ then }) => [
        then.assert("scope changes rebuild the manager runtime", async ({ runtime }) => {
          await prompt(runtime, execution);
          await runtime.drain();
          expect(JSON.stringify((await view(runtime, execution)).entries)).toContain(
            "Prompted the user-scoped agent.",
          );
          const other = { ...execution, scope: userScope };
          const personal = await (await request(runtime, other, "/agents/assistant", null)).json();
          // The personal agent inherits the organization agent's billing owner.
          expect(personal).toMatchObject({ provisioning: { billingOrganizationId: "org-1" } });
          expect(JSON.stringify((await view(runtime, other)).entries)).toContain(
            "The personal agent answered.",
          );
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
  const objectOverrides: LocalBackofficeObjects = {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage("PRIVATE_ASSISTANT_OUTPUT"),
        fauxAssistantMessage("PRIVATE_SECOND_OUTPUT"),
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      return new InMemoryPiObject({
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          extensions: (agentConfig, agent) => [
            createPiPostHogExtension({
              config: agentConfig,
              agent,
              capture: async (event) => {
                client.capture(event);
              },
            }),
          ],
        },
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
              const authenticatedRequest = new Request(`${origin}/backoffice/agents`, {
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
              const admission = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "assistant",
                {
                  requestId: "accepted-prompt",
                  content: "PRIVATE_USER_PROMPT",
                  whenBusy: "reject",
                  billingOrganizationId: null,
                },
              );
              expect(admission).toMatchObject({
                receipt: { requestId: "accepted-prompt" },
                error: null,
              });
              const rejected = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "missing-agent",
                {
                  requestId: "rejected-prompt",
                  content: "PRIVATE_REJECTED_PROMPT",
                  whenBusy: "reject",
                  billingOrganizationId: null,
                },
              );
              assert(rejected.error !== null);
              await ctx.runtime.drain();
              await shutdownCloudflarePostHog(client);
              expect(
                received.filter((event) => event.event === "agent_prompt_admitted"),
              ).toHaveLength(1);
              const generation = received.filter((event) => event.event === "$ai_generation");
              expect(generation).toHaveLength(1);
              const userId = generation[0].distinct_id;
              expect(userId).not.toMatch(/^pi-agent:/);
              expect(generation[0].uuid).toBe(generation[0].properties.$ai_span_id);
              const agentId = piAgentObjectName({ scope, agentName: "assistant" });
              expect(generation[0].properties).toMatchObject({
                agent_name: "assistant",
                $ai_session_id: agentId,
                $ai_provider: "faux",
                $ai_model: "faux-1",
                $ai_is_error: false,
                $process_person_profile: false,
              });
              for (const marker of [
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
              expect(exceptions[0].distinct_id).toBe(userId);

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
              const second = await submitPiManagerPrompt(
                authenticatedRequest,
                context,
                scope,
                "assistant",
                {
                  requestId: "second-prompt",
                  content: "PRIVATE_SECOND_PROMPT",
                  whenBusy: "followUp",
                  billingOrganizationId: null,
                },
              );
              await shutdownCloudflarePostHog(failedDeliveryClient);
              expect(second).toMatchObject({
                receipt: { requestId: "second-prompt" },
                error: null,
              });
              const persisted = await fetchPiManagerAgents(authenticatedRequest, context, scope);
              expect(
                persisted.agents.find((agent) => agent.agentName === "assistant")?.provisioning,
              ).toEqual({ billingOrganizationId: organization.id });
              expect(
                received.filter((event) => event.event === "agent_prompt_admitted"),
              ).toHaveLength(1);
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
