import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PiManagerAgent, PiManagerAgentDirectory } from "@fragno-dev/backoffice-api/v0/pi";
import {
  backofficeScopeOrganization,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type ConversationView,
  type LiveState,
} from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeObjectScopeFromContextScope } from "@/backoffice-runtime/object-registry";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";

import {
  createPiScenarioDependencies,
  createScriptedPiAgentDependencies,
} from "./pi-durable-scenario.test-support";
import { InMemoryPiObject } from "./pi.do";

const scenarioObjects = allLocalObjects;

const PI_SCENARIO_AVAILABLE_MODELS = [
  { provider: "faux", modelId: "faux-1", label: "Faux 1", contextWindow: 128_000 },
] as const;

const scopes = [
  { kind: "system" },
  { kind: "org", orgId: "shared-id" },
  { kind: "user", userId: "shared-id" },
  { kind: "project", owner: { kind: "org", orgId: "shared-id" }, projectId: "project-1" },
  { kind: "project", owner: { kind: "org", orgId: "other-org" }, projectId: "project-1" },
] satisfies BackofficeContextScope[];

const objectOverrides = {
  PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) =>
    new InMemoryPiObject({
      state,
      dependencies: createPiScenarioDependencies(),
      runtime,
      openStorage: openPiSessionStore,
      idFromConfig: piAgentIdFromConfig,
      nowEpochMs,
    }),
} satisfies LocalBackofficeObjects;

function scopeExecution(scope: BackofficeContextScope, serviceId = "pi-manager-scenario") {
  return scope.kind === "system"
    ? createBackofficeSystemExecution(scope)
    : createBackofficeServiceExecution({ scope, service: { type: "automation", id: serviceId } });
}

async function managerRequest(
  runtime: InMemoryBackofficeRuntime,
  scope: BackofficeContextScope,
  route: string,
  body?: unknown,
  execution: BackofficeExecutionContext = scopeExecution(scope),
  method: "GET" | "POST" | "PUT" | "DELETE" = body === undefined ? "GET" : "POST",
) {
  const hasBody = body !== undefined && body !== null;
  return await runtime.objects.piManager.for(scope).http.fetchAuthorized(
    new Request(`https://backoffice.example/api/pi-manager${route}`, {
      method,
      headers: hasBody ? { "content-type": "application/json" } : {},
      body: hasBody ? JSON.stringify(body) : undefined,
    }),
    { execution },
  );
}

async function prompt(
  runtime: InMemoryBackofficeRuntime,
  scope: BackofficeContextScope,
  input: { requestId: string; content: string; agentName?: string },
) {
  const { agentName = "assistant", ...body } = input;
  return await managerRequest(runtime, scope, `/agents/${agentName}/prompts`, {
    ...body,
    billingOrganizationId: scope.kind === "user" ? "billing-org" : null,
  });
}

async function readView(
  runtime: InMemoryBackofficeRuntime,
  scope: BackofficeContextScope,
  agentName = "assistant",
) {
  const response = await managerRequest(runtime, scope, `/agents/${agentName}/view`);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json<ConversationView>();
}

async function readPiViewStreamFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
) {
  const decoder = new TextDecoder();
  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex >= 0) {
      const line = state.buffer.slice(0, newlineIndex);
      state.buffer = state.buffer.slice(newlineIndex + 1);
      return JSON.parse(line) as { type: "snapshot" | "update"; view: ConversationView };
    }
    const result = await reader.read();
    if (result.done) {
      throw new Error("Pi view stream closed before the expected frame.");
    }
    state.buffer += decoder.decode(result.value, { stream: true });
  }
}

function userEntryTexts(view: ConversationView) {
  return view.entries
    .filter((entry) => entry.kind === "pi.user")
    .map((entry) =>
      (entry.model ?? [])
        .map((message) =>
          typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        )
        .join(""),
    );
}

test("agents are defined through the manager, checked on write, and keep their conversation when redefined", async () => {
  const orgId = "definitions-org";
  const scope: BackofficeContextScope = { kind: "org", orgId };
  const reviewer = {
    agentName: "reviewer",
    description: "Reviews changes.",
    model: null,
    permissions: ["upload.read"],
    instructions: "Review carefully.",
    managedBy: null,
  };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "manager-defined Pi agents",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      setup: ({ given }) => [given.organization.exists({ id: orgId })],
      steps: ({ then }) => [
        then.assert("refuse definitions that could not run", async ({ runtime }) => {
          const refusals = [
            [{ ...reviewer, permissions: ["nope.read"] }, 400],
            [{ ...reviewer, permissions: [] }, 400],
            [{ ...reviewer, instructions: "x".repeat(32_769) }, 400],
            [{ ...reviewer, agentName: "Reviewer" }, 400],
            [{ ...reviewer, agentName: "assistant" }, 409],
          ] as const;
          for (const [definition, status] of refusals) {
            const response = await managerRequest(runtime, scope, "/agents", definition);
            assert.equal(response.status, status, await response.clone().text());
          }
          for (const method of ["PUT", "DELETE"] as const) {
            const builtIn = await managerRequest(
              runtime,
              scope,
              "/agents/assistant",
              method === "PUT" ? reviewer : null,
              undefined,
              method,
            );
            assert.equal(builtIn.status, 409, method);
            expect(await builtIn.json()).toMatchObject({ code: "AGENT_BUILT_IN" });
          }
        }),
        then.assert("define agents and list them with the built-in ones", async ({ runtime }) => {
          for (const definition of [
            reviewer,
            { ...reviewer, agentName: "offline", model: "faux/missing", instructions: "" },
          ]) {
            const created = await managerRequest(runtime, scope, "/agents", definition);
            assert.equal(created.status, 201, await created.clone().text());
          }
          const duplicate = await managerRequest(runtime, scope, "/agents", reviewer);
          assert.equal(duplicate.status, 409);
          expect(await duplicate.json()).toMatchObject({ code: "AGENT_EXISTS" });
          const directory = await (
            await managerRequest(runtime, scope, "/agents")
          ).json<PiManagerAgentDirectory>();
          expect(
            directory.agents.map(({ agentName, managedBy }) => [agentName, managedBy]),
          ).toEqual([
            ["assistant", { kind: "built-in" }],
            ["offline", null],
            ["reviewer", null],
          ]);
          assert(directory.agents.every((agent) => agent.provisioning === null));
        }),
        then.assert("provision an agent with its first turn", async ({ runtime }) => {
          const notStarted = await managerRequest(runtime, scope, "/agents/reviewer/view");
          assert.equal(notStarted.status, 404);
          expect(await notStarted.json()).toMatchObject({ code: "AGENT_NOT_STARTED" });

          const submitted = await prompt(runtime, scope, {
            agentName: "reviewer",
            requestId: "review-1",
            content: "Review the change.",
          });
          assert.equal(submitted.status, 202, await submitted.clone().text());
          await runtime.drain();
          const agent = await (
            await managerRequest(runtime, scope, "/agents/reviewer")
          ).json<PiManagerAgent>();
          expect(agent.provisioning).toEqual({ billingOrganizationId: orgId });
          const view = await readView(runtime, scope, "reviewer");
          expect(JSON.stringify(view.entries)).toContain("durable answer");
        }),
        then.assert("refuse turns that no definition allows", async ({ runtime }) => {
          const offline = await prompt(runtime, scope, {
            agentName: "offline",
            requestId: "offline-1",
            content: "Answer.",
          });
          assert.equal(offline.status, 400);
          expect(await offline.json()).toEqual({
            code: "MODEL_UNAVAILABLE",
            message: "Pi model faux/missing is not available.",
          });
          for (const agentName of ["missing", "..%2Fsecrets"]) {
            const undefinedAgent = await prompt(runtime, scope, {
              agentName,
              requestId: `${agentName}-1`,
              content: "Answer.",
            });
            assert.equal(undefinedAgent.status, 404, agentName);
            expect(await undefinedAgent.json()).toMatchObject({ code: "AGENT_NOT_FOUND" });
          }
        }),
        then.assert(
          "a deleted agent cannot be prompted and resumes its conversation when defined again",
          async ({ runtime }) => {
            const deleted = await managerRequest(
              runtime,
              scope,
              "/agents/reviewer",
              null,
              undefined,
              "DELETE",
            );
            assert.equal(deleted.status, 204, await deleted.clone().text());
            const gone = await prompt(runtime, scope, {
              agentName: "reviewer",
              requestId: "review-gone",
              content: "Review again.",
            });
            assert.equal(gone.status, 404);
            const recreated = await managerRequest(runtime, scope, "/agents", reviewer);
            assert.equal(recreated.status, 201, await recreated.clone().text());
            const { agentName: _agentName, ...fields } = reviewer;
            const replaced = await managerRequest(
              runtime,
              scope,
              "/agents/reviewer",
              { ...fields, description: "Reviews and approves changes." },
              undefined,
              "PUT",
            );
            assert.equal(replaced.status, 200, await replaced.clone().text());
            const resumed = await prompt(runtime, scope, {
              agentName: "reviewer",
              requestId: "review-2",
              content: "Review again.",
            });
            assert.equal(resumed.status, 202, await resumed.clone().text());
            await runtime.drain();
            expect(userEntryTexts(await readView(runtime, scope, "reviewer"))).toEqual([
              "Review the change.",
              "Review again.",
            ]);
            const directory = await (
              await managerRequest(runtime, scope, "/agents")
            ).json<PiManagerAgentDirectory>();
            expect(
              directory.agents.map((agent) => [agent.agentName, agent.description]),
            ).toContainEqual(["reviewer", "Reviews and approves changes."]);
          },
        ),
      ],
    }),
  );
});

test("each scope's agents keep separate conversations and run real durable tool tasks", async () => {
  const views = new Map<BackofficeContextScope, ConversationView>();
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "scoped durable Pi agents",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      steps: ({ then }) => [
        then.assert(
          "a user-scoped agent's first turn needs a billing owner",
          async ({ runtime }) => {
            const scope: BackofficeContextScope = { kind: "user", userId: "shared-id" };
            const unbilled = await managerRequest(runtime, scope, "/agents/assistant/prompts", {
              requestId: "unbilled",
              content: "Answer.",
              billingOrganizationId: null,
            });
            assert.equal(unbilled.status, 400);
            expect(await unbilled.json()).toMatchObject({ code: "PI_BILLING_OWNER_REQUIRED" });
          },
        ),
        then.assert("prompt the same agent name in every scope", async ({ runtime }) => {
          const modelCatalog = await (await managerRequest(runtime, scopes[0], "/models")).json();
          expect(modelCatalog).toEqual(PI_SCENARIO_AVAILABLE_MODELS);
          for (const scope of scopes) {
            const response = await prompt(runtime, scope, {
              requestId: "shared-request-id",
              content: "Echo and answer.",
            });
            assert.equal(response.status, 202, await response.clone().text());
          }
          await runtime.drain();
        }),
        then.assert("each conversation contains only its own scope's turn", async ({ runtime }) => {
          for (const scope of scopes) {
            const view = await readView(runtime, scope);
            expect(view.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
            expect(view.entries.map((entry) => entry.kind)).toContain("pi.tool-result");
            expect(JSON.stringify(view.entries)).toContain("durable answer");
            const submission = await (
              await managerRequest(
                runtime,
                scope,
                "/agents/assistant/submissions/shared-request-id",
              )
            ).json();
            expect(submission).toMatchObject({ status: "done", requestId: "shared-request-id" });
            views.set(scope, view);
          }
        }),
        then.assert(
          "a repeated request and a manager restart keep the conversation",
          async ({ runtime }) => {
            for (const scope of scopes) {
              const duplicate = await prompt(runtime, scope, {
                requestId: "shared-request-id",
                content: "Echo and answer.",
              });
              assert.equal(duplicate.status, 202);
              await runtime.restartObject({
                binding: "PI_MANAGER",
                scope: backofficeObjectScopeFromContextScope(scope),
              });
              await runtime.drain();
              expect((await readView(runtime, scope)).entries).toEqual(views.get(scope)?.entries);
            }
          },
        ),
        then.assert(
          "unsigned, wrong-context, and unprivileged requests cannot access the directory",
          async ({ runtime }) => {
            const scope: BackofficeContextScope = { kind: "user", userId: "shared-id" };
            const manager = runtime.objects.piManager.for(scope);
            const url = "https://backoffice.example/api/pi-manager/agents";
            assert.equal((await manager.http.fetch(new Request(url))).status, 401);
            assert.equal(
              (
                await manager.http.fetchAuthorized(new Request(url), {
                  execution: createBackofficeServiceExecution({
                    scope,
                    service: { type: "agent", id: "unprivileged" },
                  }),
                })
              ).status,
              403,
            );
            assert.equal(
              (
                await manager.http.fetchAuthorized(new Request(url), {
                  execution: createBackofficeServiceExecution({
                    scope: { kind: "user", userId: "another-user" },
                    service: { type: "automation", id: "wrong-user" },
                  }),
                })
              ).status,
              401,
            );
          },
        ),
      ],
    }),
  );
});

test("a busy agent runs other principals' prompts as follow-up turns, lets its own turn be steered, and refuses rejectable prompts", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "turns-org" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "single-threaded durable Pi turns",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
          // A slow tool call keeps the first turn running while the other prompts are admitted.
          const faux = fauxProvider({ tokensPerSecond: 40, tokenSize: { min: 1, max: 1 } });
          faux.setResponses([
            fauxAssistantMessage([fauxToolCall("echo", { text: "a tool boundary for steering" })], {
              stopReason: "toolUse",
            }),
            fauxAssistantMessage([fauxText("First turn answer.")]),
            fauxAssistantMessage([fauxText("Follow-up turn answer.")]),
          ]);
          const models = createModels();
          models.setProvider(faux.provider);
          const scenario = defineExtension({
            name: "scenario",
            tools: [
              defineTool({
                name: "echo",
                description: "Echo the provided text.",
                parameters: Type.Object({ text: Type.String() }),
                replay: "safe",
                execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
              }),
            ],
          });
          return new InMemoryPiObject({
            state,
            dependencies: {
              ...createScriptedPiAgentDependencies(models),
              extensions: () => [scenario],
            },
            runtime,
            openStorage: openPiSessionStore,
            idFromConfig: piAgentIdFromConfig,
            nowEpochMs,
          });
        },
      },
      steps: ({ then }) => [
        then.assert("admit prompts while the first turn runs", async ({ runtime }) => {
          const ada = scopeExecution(scope, "ada");
          const grace = scopeExecution(scope, "grace");
          const submit = async (
            execution: BackofficeExecutionContext,
            requestId: string,
            content: string,
            whenBusy: "steer" | "reject",
          ) =>
            await managerRequest(
              runtime,
              scope,
              "/agents/assistant/prompts",
              { requestId, content, whenBusy, billingOrganizationId: null },
              execution,
            );
          const receipts = [];
          for (const [execution, requestId, content] of [
            [ada, "ada-first", "Ada starts a turn."],
            [grace, "grace-steer", "Grace tries to steer."],
            [ada, "ada-steer", "Ada steers her turn."],
          ] as const) {
            const response = await submit(execution, requestId, content, "steer");
            assert.equal(response.status, 202, await response.clone().text());
            receipts.push(await response.json<{ requestId: string; whenBusy: string }>());
          }
          // The receipt tells Grace her steer was queued instead.
          expect(receipts.map(({ requestId, whenBusy }) => [requestId, whenBusy])).toEqual([
            ["ada-first", "steer"],
            ["grace-steer", "followUp"],
            ["ada-steer", "steer"],
          ]);
          const rejected = await submit(grace, "grace-reject", "Only if idle.", "reject");
          assert(rejected.status === 409);
          expect(await rejected.json()).toMatchObject({ code: "AGENT_BUSY" });
          await runtime.drain();

          // A rejected prompt is not queued and never runs.
          assert(
            (await managerRequest(runtime, scope, "/agents/assistant/submissions/grace-reject"))
              .status === 404,
          );

          const view = await readView(runtime, scope);
          // Ada's steering joins her running turn; Grace's prompt waits for a turn of its own.
          expect(userEntryTexts(view)).toEqual([
            "Ada starts a turn.",
            "Ada steers her turn.",
            "Grace tries to steer.",
          ]);
          const graceSubmission = await (
            await managerRequest(runtime, scope, "/agents/assistant/submissions/grace-steer")
          ).json<{ status: string; answer: number }>();
          assert(graceSubmission.status === "done");
          const graceAnswer = view.entries.find((entry) => entry.id === graceSubmission.answer);
          expect(JSON.stringify(graceAnswer)).toContain("Follow-up turn answer.");
        }),
      ],
    }),
  );
});

test("the Pi manager long-polls a server-side submission waiter", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "submission-wait-org" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "wait for durable Pi submission settlement",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objects: { ...scenarioObjects, ...objectOverrides },
      steps: ({ then }) => [
        then.assert(
          "resolve the manager request when the submission settles",
          async ({ runtime }) => {
            const submitted = await prompt(runtime, scope, {
              requestId: "waited-prompt",
              content: "Echo and answer.",
            });
            assert.equal(submitted.status, 202, await submitted.clone().text());

            const waiting = managerRequest(
              runtime,
              scope,
              "/agents/assistant/submissions/waited-prompt/wait?waitMs=5000",
            );
            const draining = runtime.drain();
            const response = await waiting;
            assert.equal(response.status, 200, await response.clone().text());
            expect(await response.json()).toMatchObject({
              status: "settled",
              submission: { status: "done", requestId: "waited-prompt" },
            });
            await draining;
          },
        ),
      ],
    }),
  );
});

test("the local Pi view stream publishes durable generation partials before completion", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "streaming-org" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "stream durable Pi generation partials",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objects: {
        ...scenarioObjects,
        PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
          const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
          faux.setResponses([
            fauxAssistantMessage([
              fauxText("This response is long enough to commit more than one partial update."),
            ]),
          ]);
          const models = createModels();
          models.setProvider(faux.provider);
          return new InMemoryPiObject({
            state,
            dependencies: createScriptedPiAgentDependencies(models),
            runtime,
            openStorage: openPiSessionStore,
            idFromConfig: piAgentIdFromConfig,
            nowEpochMs,
          });
        },
      },
      steps: ({ then }) => [
        then.assert("stream a live partial and the committed answer", async ({ runtime }) => {
          const notStarted = await managerRequest(runtime, scope, "/agents/assistant/view-stream");
          assert.equal(notStarted.status, 404);

          const submitted = await prompt(runtime, scope, {
            requestId: "streamed-prompt",
            content: "Write the streamed answer.",
          });
          assert.equal(submitted.status, 202, await submitted.clone().text());
          const response = await managerRequest(runtime, scope, "/agents/assistant/view-stream");
          assert.equal(response.status, 200);
          const reader = response.body!.getReader();
          const streamState = { buffer: "" };
          expect(await readPiViewStreamFrame(reader, streamState)).toMatchObject({
            type: "snapshot",
          });
          const pending = await managerRequest(
            runtime,
            scope,
            "/agents/assistant/submissions/streamed-prompt/wait?waitMs=1",
          );
          assert.equal(pending.status, 200, await pending.clone().text());
          expect(await pending.json()).toEqual({ status: "pending", submission: null });
          const draining = runtime.drain();
          let sawUncommittedPartial = false;
          let completedView: ConversationView | null = null;
          while (!completedView) {
            const frame = await readPiViewStreamFrame(reader, streamState);
            const live = frame.view.docs["pi.live"] as Readonly<LiveState> | undefined;
            if (
              live?.generation?.message !== undefined &&
              !frame.view.entries.some((entry) => entry.kind === "pi.assistant")
            ) {
              sawUncommittedPartial = true;
            }
            if (JSON.stringify(frame.view.entries).includes("long enough")) {
              completedView = frame.view;
            }
          }
          await draining;
          await reader.cancel();
          assert(sawUncommittedPartial);
          expect(JSON.stringify(completedView.entries)).toContain("long enough");
        }),
      ],
    }),
  );
});

test("durable Pi paginates history, streams exports, and compacts without deleting entries", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "history-org" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi history export and compaction",
      options: { drain: false },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      objects: {
        ...scenarioObjects,
        PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
          const faux = fauxProvider();
          faux.setResponses([
            fauxAssistantMessage([fauxText("Original durable answer.")]),
            fauxAssistantMessage([fauxText("Compacted durable summary.")]),
          ]);
          const models = createModels();
          models.setProvider(faux.provider);
          return new InMemoryPiObject({
            state,
            dependencies: {
              ...createScriptedPiAgentDependencies(models),
              settings: { compaction: { keepRecentTokens: 1 } },
            },
            runtime,
            openStorage: openPiSessionStore,
            idFromConfig: piAgentIdFromConfig,
            nowEpochMs,
          });
        },
      },
      steps: ({ then }) => [
        then.assert("retain raw history after a manual durable compaction", async ({ runtime }) => {
          const submitted = await prompt(runtime, scope, {
            requestId: "history-prompt",
            content: "Create history.",
          });
          assert.equal(submitted.status, 202, await submitted.clone().text());
          await runtime.drain();

          const firstHistoryPage = await managerRequest(
            runtime,
            scope,
            "/agents/assistant/entries?pageSize=1",
          );
          assert.equal(firstHistoryPage.status, 200);
          const firstPage = await firstHistoryPage.json<{
            entries: Array<{ id: number }>;
            cursor: string | null;
            hasNextPage: boolean;
          }>();
          expect(firstPage.entries).toHaveLength(1);
          assert(firstPage.hasNextPage);
          assert(firstPage.cursor);

          const secondPage = await (
            await managerRequest(
              runtime,
              scope,
              `/agents/assistant/entries?pageSize=1&cursor=${encodeURIComponent(firstPage.cursor)}`,
            )
          ).json<{ entries: Array<{ id: number }>; hasNextPage: boolean }>();
          expect(secondPage.entries).toHaveLength(1);
          expect(secondPage.entries[0]?.id).not.toBe(firstPage.entries[0]?.id);

          const exported = await managerRequest(runtime, scope, "/agents/assistant/export");
          assert.equal(exported.status, 200);
          expect(exported.headers.get("content-disposition")).toContain("pi-agent-assistant");
          const exportLines = (await exported.text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(exportLines[0]).toMatchObject({
            type: "pi-durable-agent",
            version: 1,
            order: "newest-first",
            agent: { agentName: "assistant", scope },
          });
          expect(exportLines.filter((line) => line.type === "entry").length).toBeGreaterThan(1);

          const compacted = await managerRequest(runtime, scope, "/agents/assistant/compact", {
            instructions: "Preserve the durable answer.",
          });
          assert.equal(compacted.status, 202, await compacted.clone().text());
          const { taskId } = await compacted.json<{ taskId: number }>();
          await runtime.drain();

          const compaction = await (
            await managerRequest(runtime, scope, `/agents/assistant/compactions/${taskId}`)
          ).json();
          expect(compaction).toEqual({ taskId, status: "completed", message: null });
          const activeView = await readView(runtime, scope);
          expect(JSON.stringify(activeView.entries)).toContain("Compacted durable summary.");

          const retainedHistory = await (
            await managerRequest(runtime, scope, "/agents/assistant/entries?pageSize=256")
          ).json<{ entries: unknown[] }>();
          expect(JSON.stringify(retainedHistory.entries)).toContain("Original durable answer.");
          expect(JSON.stringify(retainedHistory.entries)).toContain("Compacted durable summary.");
        }),
      ],
    }),
  );
});

test("SQLite Pi directories and agent transcripts survive a complete local runtime restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-pi-manager-"));
  const views: { scope: BackofficeContextScope; view: ConversationView }[] = [];
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "persist scoped Pi directories and agents",
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        options: { sqliteDataDirectory: directory, drain: false },
        objects: { ...scenarioObjects, ...objectOverrides },
        steps: ({ then }) => [
          then.assert(
            "commit each directory and agent transcript to SQLite",
            async ({ runtime }) => {
              for (const scope of scopes) {
                const submitted = await prompt(runtime, scope, {
                  requestId: "persisted-prompt",
                  content: "Persist this answer.",
                });
                assert.equal(submitted.status, 202, await submitted.clone().text());
                await runtime.drain();
                const view = await readView(runtime, scope);
                expect(JSON.stringify(view.entries)).toContain("durable answer");
                views.push({ scope, view });
              }
            },
          ),
        ],
      }),
    );
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "restore scoped Pi directories and agents",
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        options: { sqliteDataDirectory: directory, drain: false },
        objects: { ...scenarioObjects, ...objectOverrides },
        steps: ({ then }) => [
          then.assert(
            "restore provisioning, transcript, and submission deduplication",
            async ({ runtime }) => {
              for (const { scope, view } of views) {
                const agent = await (
                  await managerRequest(runtime, scope, "/agents/assistant")
                ).json<PiManagerAgent>();
                expect(agent.provisioning).toEqual({
                  billingOrganizationId:
                    scope.kind === "system"
                      ? null
                      : (backofficeScopeOrganization(scope)?.orgId ?? "billing-org"),
                });
                const duplicate = await prompt(runtime, scope, {
                  requestId: "persisted-prompt",
                  content: "Persist this answer.",
                });
                assert.equal(duplicate.status, 202, await duplicate.clone().text());
                await runtime.drain();
                expect((await readView(runtime, scope)).entries).toEqual(view.entries);
                const submission = await (
                  await managerRequest(
                    runtime,
                    scope,
                    "/agents/assistant/submissions/persisted-prompt",
                  )
                ).json();
                expect(submission).toMatchObject({ status: "done" });
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

test("a cold local agent alarm resumes unfinished SQLite work without duplicating input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-pi-recovery-"));
  const scope: BackofficeContextScope = { kind: "user", userId: "recovering-user" };
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "persist unfinished local Pi work",
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        options: { sqliteDataDirectory: directory, drain: false },
        objects: {
          ...scenarioObjects,
          PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
            // Short chunks keep cancellation bounded while the full answer remains deliberately slow.
            const slow = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } });
            slow.setResponses([
              fauxAssistantMessage([fauxText("An answer that cannot finish before shutdown.")]),
            ]);
            const models = createModels();
            models.setProvider(slow.provider);
            return new InMemoryPiObject({
              state,
              dependencies: { ...createPiScenarioDependencies(), models },
              runtime,
              openStorage: openPiSessionStore,
              idFromConfig: piAgentIdFromConfig,
              nowEpochMs,
            });
          },
        },
        steps: ({ then }) => [
          then.assert("admit a prompt before stopping the local runtime", async ({ runtime }) => {
            const submitted = await prompt(runtime, scope, {
              requestId: "unfinished",
              content: "Recover this input.",
            });
            assert.equal(submitted.status, 202, await submitted.clone().text());
            const submission = await (
              await managerRequest(runtime, scope, "/agents/assistant/submissions/unfinished")
            ).json();
            expect(submission).not.toMatchObject({ status: "done" });
          }),
        ],
      }),
    );
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "resume unfinished local Pi work",
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        options: { sqliteDataDirectory: directory, drain: false },
        objects: { ...scenarioObjects, ...objectOverrides },
        steps: ({ then }) => [
          then.assert(
            "deliver the restored alarm and finish the original submission",
            async ({ runtime }) => {
              await runtime.drain();
              const submission = await (
                await managerRequest(runtime, scope, "/agents/assistant/submissions/unfinished")
              ).json();
              expect(submission).toMatchObject({ status: "done", requestId: "unfinished" });
              const view = await readView(runtime, scope);
              expect(view.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
              expect(JSON.stringify(view.entries)).toContain("durable answer");
            },
          ),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
