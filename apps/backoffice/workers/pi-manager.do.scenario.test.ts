import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";

import { createRegistry, type ConversationView, type LiveState } from "@earendil-works/pi-durable";

import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { LocalObjectFactoryOverrides } from "@/backoffice-runtime/local-object-factory";
import { backofficeObjectScopeFromContextScope } from "@/backoffice-runtime/object-registry";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import type { PiAgentConfig } from "@/fragno/pi-manager/pi-agent-contract";

import { createPiScenarioHarnessOptions } from "./pi-durable-scenario.test-support";
import { InMemoryPiObject } from "./pi.do";

const PI_SCENARIO_AVAILABLE_MODELS = [
  { provider: "faux", modelId: "faux-1", label: "Faux 1" },
] as const;

const scopes = [
  { kind: "system" },
  { kind: "org", orgId: "shared-id" },
  { kind: "user", userId: "shared-id" },
  { kind: "project", orgId: "shared-id", projectId: "project-1" },
  { kind: "project", orgId: "other-org", projectId: "project-1" },
] satisfies BackofficeContextScope[];

const objectFactories = {
  PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) =>
    new InMemoryPiObject({
      state,
      options: createPiScenarioHarnessOptions(),
      runtime,
      openStorage: openPiSessionStore,
      idFromConfig: piAgentIdFromConfig,
      nowEpochMs,
    }),
} satisfies LocalObjectFactoryOverrides;

async function managerRequest(
  runtime: InMemoryBackofficeRuntime,
  scope: BackofficeContextScope,
  route: string,
  body?: unknown,
) {
  return await runtime.objects.piManager.for(scope).http.fetchAuthorized(
    new Request(`https://backoffice.example/api/pi-manager${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      execution:
        scope.kind === "system"
          ? createBackofficeSystemExecution(scope)
          : createBackofficeServiceExecution({
              scope,
              service: { type: "automation", id: "pi-manager-scenario" },
            }),
    },
  );
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

async function createSession(runtime: InMemoryBackofficeRuntime, scope: BackofficeContextScope) {
  const response = await managerRequest(runtime, scope, "/sessions", {
    name: "Local agent",
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "Answer durably.",
    billingOrganizationId: scope.kind === "user" ? "billing-org" : null,
    // A caller cannot change the directory's ownership or choose another agent's identity.
    scope: { kind: "org", orgId: "untrusted-body-org" },
    sessionId: "untrusted-session",
  });
  assert.equal(response.status, 201, await response.clone().text());
  const session = await response.json<PiAgentConfig>();
  expect(session.scope).toEqual(scope);
  expect(session.sessionId).not.toBe("untrusted-session");
  return session;
}

test("the Pi manager idempotently creates one session for a stable request", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "idempotent-session-org" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "idempotent durable Pi session creation",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objectFactories,
      steps: ({ then }) => [
        then.assert("reuse the first session created for one request", async ({ runtime }) => {
          const input = {
            requestId: "workflow-1:create-agent",
            name: "Workflow agent",
            model: { provider: "faux", modelId: "faux-1" },
            instructions: "Answer durably.",
            billingOrganizationId: null,
          };
          const first = await managerRequest(runtime, scope, "/sessions", input);
          assert.equal(first.status, 201, await first.clone().text());
          const firstSession = await first.json<PiAgentConfig>();

          const replay = await managerRequest(runtime, scope, "/sessions", {
            ...input,
            name: "Ignored replay name",
          });
          assert.equal(replay.status, 200, await replay.clone().text());
          expect(await replay.json<PiAgentConfig>()).toEqual(firstSession);

          const listing = await managerRequest(runtime, scope, "/sessions");
          expect(await listing.json()).toMatchObject({
            sessions: [{ sessionId: firstSession.sessionId, name: "Workflow agent" }],
            hasNextPage: false,
          });
        }),
      ],
    }),
  );
});

test("local Pi managers isolate all Automations scopes and execute real durable tool tasks", async () => {
  const sessions: PiAgentConfig[] = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "local durable Pi directories and agent handoff in every scope",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objectFactories,
      steps: ({ then }) => [
        then.assert(
          "create scoped directories and hand off prompts to distinct agents",
          async ({ runtime }) => {
            const modelCatalog = await (await managerRequest(runtime, scopes[0], "/models")).json();
            expect(modelCatalog).toEqual(PI_SCENARIO_AVAILABLE_MODELS);
            const unavailableModel = await managerRequest(runtime, scopes[0], "/sessions", {
              name: "Unavailable model",
              model: { provider: "faux", modelId: "missing" },
              instructions: "",
            });
            assert.equal(unavailableModel.status, 400);
            expect(await unavailableModel.json()).toEqual({
              code: "MODEL_UNAVAILABLE",
              message: "Pi model faux/missing is not available.",
            });

            for (const scope of scopes) {
              const session = await createSession(runtime, scope);
              sessions.push(session);
              const response = await managerRequest(
                runtime,
                scope,
                `/sessions/${session.sessionId}/prompts`,
                { requestId: "shared-request-id", content: "Echo and answer." },
              );
              assert.equal(response.status, 202, await response.clone().text());
            }
            await runtime.drain();
          },
        ),
        then.assert(
          "each directory and transcript contains only its own session",
          async ({ runtime }) => {
            for (const session of sessions) {
              const list = await managerRequest(runtime, session.scope, "/sessions");
              assert.equal(list.status, 200);
              expect(await list.json()).toMatchObject({
                sessions: [{ sessionId: session.sessionId, scope: session.scope }],
                hasNextPage: false,
              });
              const view = await (
                await managerRequest(runtime, session.scope, `/sessions/${session.sessionId}/view`)
              ).json<ConversationView>();
              expect(view.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
              expect(view.entries.map((entry) => entry.kind)).toContain("pi.tool-result");
              expect(JSON.stringify(view.entries)).toContain("durable answer");
              const submission = await (
                await managerRequest(
                  runtime,
                  session.scope,
                  `/sessions/${session.sessionId}/submissions/shared-request-id`,
                )
              ).json();
              expect(submission).toMatchObject({ status: "done", requestId: "shared-request-id" });
              const foreign = sessions.find(
                (candidate) => candidate.sessionId !== session.sessionId,
              )!;
              const denied = await managerRequest(
                runtime,
                session.scope,
                `/sessions/${foreign.sessionId}/prompts`,
                { requestId: "foreign", content: "Must not reach another scope." },
              );
              assert.equal(denied.status, 404);
              const duplicate = await managerRequest(
                runtime,
                session.scope,
                `/sessions/${session.sessionId}/prompts`,
                { requestId: "shared-request-id", content: "Echo and answer." },
              );
              assert.equal(duplicate.status, 202);
              await runtime.restartObject({
                binding: "PI_MANAGER",
                scope: backofficeObjectScopeFromContextScope(session.scope),
              });
              const restored = await (
                await managerRequest(runtime, session.scope, `/sessions/${session.sessionId}/view`)
              ).json<ConversationView>();
              expect(restored.entries).toEqual(view.entries);
            }
          },
        ),
        then.assert(
          "unsigned, wrong-context, and unprivileged requests cannot access the directory",
          async ({ runtime }) => {
            const scope: BackofficeContextScope = { kind: "user", userId: "shared-id" };
            const manager = runtime.objects.piManager.for(scope);
            const url = "https://backoffice.example/api/pi-manager/sessions";
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

test("the Pi manager long-polls a server-side submission waiter", async () => {
  const scope: BackofficeContextScope = { kind: "org", orgId: "submission-wait-org" };
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "wait for durable Pi submission settlement",
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      options: { drain: false },
      objectFactories,
      steps: ({ then }) => [
        then.assert(
          "resolve the manager request when the submission settles",
          async ({ runtime }) => {
            const created = await managerRequest(runtime, scope, "/sessions", {
              name: "Default model agent",
              instructions: "Answer durably.",
              billingOrganizationId: null,
            });
            assert.equal(created.status, 201, await created.clone().text());
            const session = await created.json<PiAgentConfig>();
            expect(session.model).toEqual({ provider: "faux", modelId: "faux-1" });
            const submitted = await managerRequest(
              runtime,
              scope,
              `/sessions/${session.sessionId}/prompts`,
              { requestId: "waited-prompt", content: "Echo and answer." },
            );
            assert.equal(submitted.status, 202, await submitted.clone().text());

            const waiting = managerRequest(
              runtime,
              scope,
              `/sessions/${session.sessionId}/submissions/waited-prompt/wait?waitMs=5000`,
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
      objectFactories: {
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
            options: { models, registry: createRegistry() },
            runtime,
            openStorage: openPiSessionStore,
            idFromConfig: piAgentIdFromConfig,
            nowEpochMs,
          });
        },
      },
      steps: ({ then }) => [
        then.assert("stream a live partial and the committed answer", async ({ runtime }) => {
          const session = await createSession(runtime, scope);
          const response = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/view-stream`,
          );
          assert.equal(response.status, 200);
          const reader = response.body!.getReader();
          const streamState = { buffer: "" };
          expect(await readPiViewStreamFrame(reader, streamState)).toMatchObject({
            type: "snapshot",
            view: { entries: [] },
          });

          const submitted = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/prompts`,
            { requestId: "streamed-prompt", content: "Write the streamed answer." },
          );
          assert.equal(submitted.status, 202, await submitted.clone().text());
          const pending = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/submissions/streamed-prompt/wait?waitMs=1`,
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
      objectFactories: {
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
            options: {
              models,
              registry: createRegistry(),
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
          const session = await createSession(runtime, scope);
          const submitted = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/prompts`,
            { requestId: "history-prompt", content: "Create history." },
          );
          assert.equal(submitted.status, 202, await submitted.clone().text());
          await runtime.drain();

          const firstHistoryPage = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/entries?pageSize=1`,
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
              `/sessions/${session.sessionId}/entries?pageSize=1&cursor=${encodeURIComponent(firstPage.cursor)}`,
            )
          ).json<{ entries: Array<{ id: number }>; hasNextPage: boolean }>();
          expect(secondPage.entries).toHaveLength(1);
          expect(secondPage.entries[0]?.id).not.toBe(firstPage.entries[0]?.id);

          const exported = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/export`,
          );
          assert.equal(exported.status, 200);
          expect(exported.headers.get("content-disposition")).toContain("pi-session-");
          const exportLines = (await exported.text())
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(exportLines[0]).toMatchObject({
            type: "pi-durable-session",
            version: 1,
            order: "newest-first",
          });
          expect(exportLines.filter((line) => line.type === "entry").length).toBeGreaterThan(1);

          const compacted = await managerRequest(
            runtime,
            scope,
            `/sessions/${session.sessionId}/compact`,
            { instructions: "Preserve the durable answer." },
          );
          assert.equal(compacted.status, 202, await compacted.clone().text());
          const { taskId } = await compacted.json<{ taskId: number }>();
          await runtime.drain();

          const compaction = await (
            await managerRequest(
              runtime,
              scope,
              `/sessions/${session.sessionId}/compactions/${taskId}`,
            )
          ).json();
          expect(compaction).toEqual({ taskId, status: "completed", message: null });
          const activeView = await (
            await managerRequest(runtime, scope, `/sessions/${session.sessionId}/view`)
          ).json<ConversationView>();
          expect(JSON.stringify(activeView.entries)).toContain("Compacted durable summary.");

          const retainedHistory = await (
            await managerRequest(
              runtime,
              scope,
              `/sessions/${session.sessionId}/entries?pageSize=256`,
            )
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
  const sessions: { config: PiAgentConfig; view: ConversationView }[] = [];
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "persist scoped Pi directories and agents",
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        options: { sqliteDataDirectory: directory, drain: false },
        objectFactories,
        steps: ({ then }) => [
          then.assert(
            "commit each directory and agent transcript to SQLite",
            async ({ runtime }) => {
              for (const scope of scopes) {
                const config = await createSession(runtime, scope);
                const submitted = await managerRequest(
                  runtime,
                  scope,
                  `/sessions/${config.sessionId}/prompts`,
                  { requestId: "persisted-prompt", content: "Persist this answer." },
                );
                assert.equal(submitted.status, 202, await submitted.clone().text());
                await runtime.drain();
                const view = await (
                  await managerRequest(runtime, scope, `/sessions/${config.sessionId}/view`)
                ).json<ConversationView>();
                expect(JSON.stringify(view.entries)).toContain("durable answer");
                sessions.push({ config, view });
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
        objectFactories,
        steps: ({ then }) => [
          then.assert(
            "restore directory ownership, transcript, and submission deduplication",
            async ({ runtime }) => {
              for (const { config, view } of sessions) {
                const list = await (
                  await managerRequest(runtime, config.scope, "/sessions")
                ).json();
                expect(list).toMatchObject({
                  sessions: [{ sessionId: config.sessionId, scope: config.scope }],
                });
                const duplicate = await managerRequest(
                  runtime,
                  config.scope,
                  `/sessions/${config.sessionId}/prompts`,
                  { requestId: "persisted-prompt", content: "Persist this answer." },
                );
                assert.equal(duplicate.status, 202, await duplicate.clone().text());
                await runtime.drain();
                const restored = await (
                  await managerRequest(runtime, config.scope, `/sessions/${config.sessionId}/view`)
                ).json<ConversationView>();
                expect(restored.entries).toEqual(view.entries);
                const submission = await (
                  await managerRequest(
                    runtime,
                    config.scope,
                    `/sessions/${config.sessionId}/submissions/persisted-prompt`,
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
  let config: PiAgentConfig;
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "persist unfinished local Pi work",
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        options: { sqliteDataDirectory: directory, drain: false },
        objectFactories: {
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
              options: { ...createPiScenarioHarnessOptions(), models },
              runtime,
              openStorage: openPiSessionStore,
              idFromConfig: piAgentIdFromConfig,
              nowEpochMs,
            });
          },
        },
        steps: ({ then }) => [
          then.assert("admit a prompt before stopping the local runtime", async ({ runtime }) => {
            config = await createSession(runtime, scope);
            const submitted = await managerRequest(
              runtime,
              scope,
              `/sessions/${config.sessionId}/prompts`,
              { requestId: "unfinished", content: "Recover this input." },
            );
            assert.equal(submitted.status, 202, await submitted.clone().text());
            const submission = await (
              await managerRequest(
                runtime,
                scope,
                `/sessions/${config.sessionId}/submissions/unfinished`,
              )
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
        objectFactories,
        steps: ({ then }) => [
          then.assert(
            "deliver the restored alarm and finish the original submission",
            async ({ runtime }) => {
              await runtime.drain();
              const submission = await (
                await managerRequest(
                  runtime,
                  scope,
                  `/sessions/${config.sessionId}/submissions/unfinished`,
                )
              ).json();
              expect(submission).toMatchObject({ status: "done", requestId: "unfinished" });
              const view = await (
                await managerRequest(runtime, scope, `/sessions/${config.sessionId}/view`)
              ).json<ConversationView>();
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
