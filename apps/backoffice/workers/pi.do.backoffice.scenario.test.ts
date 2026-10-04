import { assert, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { mkdtemp, rm } from "node:fs/promises";
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

import {
  createRegistry,
  defineExtension,
  hook,
  ToolTask,
  type ConversationView,
  type HarnessSettings,
} from "@earendil-works/pi-durable";

import {
  BACKOFFICE_SYSTEM_ACTORS,
  createBackofficeServiceExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { LocalObjectFactoryOverrides } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import type { PiAgentConfig } from "@/fragno/pi-manager/pi-agent-contract";

import { InMemoryPiObject } from "./pi.do";

const PI_SCENARIO_AVAILABLE_MODELS = [
  { provider: "faux", modelId: "faux-1", label: "Faux 1" },
] as const;

function scriptedAgents(
  responses: FauxResponseStep[],
  settings?: HarnessSettings,
): LocalObjectFactoryOverrides {
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
  const objectFactories = scriptedAgents([
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
      objectFactories,
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

test("durable Pi delivers committed model usage to its persisted billing owner", async () => {
  const execution = createBackofficeServiceExecution({
    scope: { kind: "org", orgId: "org-1" },
    service: { type: "automation", id: "durable-billing-scenario" },
  });
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "durable Pi committed usage billing",
      options: { drain: false },
      objectFactories: scriptedAgents(
        [
          fauxAssistantMessage("Usage was durably billed."),
          fauxAssistantMessage("Compaction usage was durably billed."),
        ],
        { compaction: { keepRecentTokens: 1 } },
      ),
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
  const execution = createBackofficeUserExecution({
    scope,
    userId: "member",
    verifiedRequestAuthority: {
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
      objectFactories: scriptedAgents([
        () => {
          modelCalls += 1;
          return fauxAssistantMessage("Must not run.");
        },
      ]),
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
  const objectFactories: LocalObjectFactoryOverrides = {
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
        objectFactories,
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
      objectFactories: scriptedAgents([
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
            scope: other.scope,
            actors: execution.actors,
          });
        }),
      ],
    }),
  );
});
