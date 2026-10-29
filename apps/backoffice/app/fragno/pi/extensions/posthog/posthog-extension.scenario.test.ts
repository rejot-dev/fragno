import { assert, expect, test, vi } from "vitest";

import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

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
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
  openNodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PostHog } from "posthog-node";

import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import type { BackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";

import { createScriptedPiAgentDependencies } from "../../../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../../../workers/pi-object";
import { createPiPostHogExtension } from "./posthog-extension";

type CapturedEvent = Parameters<PostHog["capture"]>[0];

const PI_SCENARIO_AVAILABLE_MODELS = [
  {
    provider: "faux",
    modelId: "faux-1",
    label: "Faux 1",
    contextWindow: 128_000,
    thinkingLevels: ["off"],
  },
] as const;

const north = { kind: "org", orgId: "north", jurisdiction: null } as const;
const south = { kind: "org", orgId: "south", jurisdiction: null } as const;
const alicePersonal = { kind: "user", userId: "alice", jurisdiction: null } as const;

/** Every agent object answers once and reports its generations to `captured`. */
function analyticsAgents(captured: CapturedEvent[]): LocalBackofficeObjects {
  return {
    PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("Done.")]);
      const models = createModels();
      models.setProvider(faux.provider);
      return new PiObject({
        state,
        runtime,
        dependencies: {
          ...createScriptedPiAgentDependencies(models),
          extensions: (config, agent) => [
            createPiPostHogExtension({
              config,
              agent,
              auth: runtime.objects.auth.singleton().commands,
              capture: async (event) => {
                captured.push(event);
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
}

async function prompt(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
  requestId: string,
) {
  const submitted = await runtime.objects.piManager.for(execution.scope).http.fetchAuthorized(
    new Request("https://pi-manager.test/api/pi-manager/agents/assistant/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, content: "Do the work." }),
    }),
    { execution, propagationContext: null },
  );
  assert.equal(submitted.status, 202, await submitted.clone().text());
}

/** Sums the token counts PostHog would report, counting each ingestion identity once. */
function reportedTokens(events: CapturedEvent[]) {
  const unique = new Map(events.map((event) => [event.uuid, event.properties ?? {}]));
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const properties of unique.values()) {
    totals.input += Number(properties.$ai_input_tokens);
    totals.output += Number(properties.$ai_output_tokens);
    totals.cacheRead += Number(properties.$ai_cache_read_input_tokens);
    totals.cacheWrite += Number(properties.$ai_cache_creation_input_tokens);
  }
  return totals;
}

async function ledgerTokens(runtime: InMemoryBackofficeRuntime, owner: BackofficeContextScope) {
  const period = new Date(runtime.now()).toISOString().slice(0, 7);
  const { trackers } = await runtime.objects.billing.for(owner).commands.getStatement({ period });
  const quantity = (meter: string) =>
    Number(trackers.find((tracker) => tracker.meter === meter)?.quantity ?? 0);
  return {
    input: quantity("ai.tokens.input"),
    output: quantity("ai.tokens.output"),
    cacheRead: quantity("ai.tokens.cache-read"),
    cacheWrite: quantity("ai.tokens.cache-write"),
  };
}

test("generations are attributed to the scope that owned them and reconcile with the usage ledger", async () => {
  const captured: CapturedEvent[] = [];
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "PostHog generation attribution across people, organizations, and system work",
      options: { drain: false },
      objects: { ...allLocalObjects, ...analyticsAgents(captured) },
      piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
      vars: () => ({ projectId: "" }),
      setup: ({ given }) => [
        given.auth.user({ id: "alice" }),
        given.auth.user({ id: "bob" }),
        given.auth.organization({ id: "north", slug: "north-co", ownerUserId: "alice" }),
        given.auth.organization({ id: "south", slug: "south-co", ownerUserId: "bob" }),
        // Bob's own organization is south; his work in north must stay north's.
        given.auth.member({ orgId: "north", userId: "bob" }),
      ],
      steps: ({ when, then }) => [
        when.project.create({
          owner: south,
          name: "Launch",
          createdByUserId: "bob",
          captureIdAs: "projectId",
        }),
        then.assert("every kind of work reports one generation", async ({ runtime, vars }) => {
          const project = { kind: "project", owner: south, projectId: vars.projectId } as const;
          await prompt(
            runtime,
            createBackofficeUserExecution({ scope: alicePersonal, userId: "alice" }),
            "personal",
          );
          await prompt(
            runtime,
            createBackofficeUserExecution({ scope: north, userId: "bob" }),
            "org",
          );
          await prompt(
            runtime,
            createBackofficeUserExecution({ scope: project, userId: "bob" }),
            "project",
          );
          await prompt(
            runtime,
            createBackofficeServiceExecution({
              scope: north,
              service: { type: "automation", id: "nightly-digest" },
            }),
            "automation",
          );
          await prompt(runtime, createBackofficeSystemExecution({ kind: "system" }), "system");
          await runtime.drain();

          expect(
            captured
              .map((event) => ({
                distinctId: event.distinctId?.startsWith("pi-agent:")
                  ? "pi-agent"
                  : event.distinctId,
                user: event.properties?.user_id,
                scope: event.properties?.scope_kind,
                organization: event.properties?.organization_id,
                slug: event.properties?.organization_slug,
                groups: event.properties?.$groups ?? null,
                cacheExclusive: event.properties?.$ai_cache_reporting_exclusive,
              }))
              .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
          ).toEqual(
            [
              { distinctId: "alice", user: "alice", scope: "user", organization: null },
              { distinctId: "bob", user: "bob", scope: "org", organization: "north" },
              { distinctId: "bob", user: "bob", scope: "project", organization: "south" },
              { distinctId: "pi-agent", user: null, scope: "org", organization: "north" },
              { distinctId: "pi-agent", user: null, scope: "system", organization: null },
            ]
              .map((expected) => ({
                ...expected,
                slug: expected.organization === null ? null : `${expected.organization}-co`,
                groups:
                  expected.organization === null ? null : { organization: expected.organization },
                cacheExclusive: true,
              }))
              .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
          );
          assert(captured.every((event) => Number(event.properties?.$ai_input_tokens) > 0));
        }),
        then.assert("each owner's reported tokens equal its ledger", async ({ runtime }) => {
          for (const [owner, ownedBy] of [
            [north, (event: CapturedEvent) => event.properties?.organization_id === "north"],
            [south, (event: CapturedEvent) => event.properties?.organization_id === "south"],
            [alicePersonal, (event: CapturedEvent) => event.properties?.scope === "user:alice"],
          ] as const) {
            expect(await ledgerTokens(runtime, owner)).toEqual(
              reportedTokens(captured.filter(ownedBy)),
            );
          }
          // System work has no customer, so it is reported without a ledger to reconcile with.
          expect(
            captured.filter((event) => event.properties?.scope_kind === "system"),
          ).toHaveLength(1);
        }),
      ],
    }),
  );
});

test("a generation replayed after a restart keeps its ingestion identity and is billed once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-posthog-replay-"));
  const snapshot = path.join(directory, "before-commit.sqlite");
  const captured: CapturedEvent[] = [];
  // A deferred response is fetched again when its poll restarts, so the same response is replayed.
  const faux = fauxProvider({ deferred: { pollAfterMs: 0 } });
  faux.setResponses([fauxAssistantMessage("Done.")]);
  const models = createModels();
  models.setProvider(faux.provider);
  let source: { agent: PiObject; options: ConstructorParameters<typeof PiObject>[0] } | null = null;
  const objects: LocalBackofficeObjects = {
    PI: ({ state, runtime, piAgentIdFromConfig, nowEpochMs }) => {
      const database = openNodeSqliteDatabase(":memory:");
      let crashed = false;
      const crashBeforeCommit = defineExtension({
        name: "crash-before-commit",
        hooks: [
          hook(GenerationTask, {
            async afterResponse() {
              if (!crashed) {
                crashed = true;
                // What a restart finds: the response was reported, its commit never happened.
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
          settings: { stream: { deferred: true } },
          extensions: (config: PiAgentConfig, agent: BackofficeAgentContext) => [
            createPiPostHogExtension({
              config,
              agent,
              auth: runtime.objects.auth.singleton().commands,
              capture: async (event) => {
                captured.push(event);
              },
            }),
            crashBeforeCommit,
          ],
        },
        openStorage: async () => await SqliteStorage.open(await database),
        idFromConfig: piAgentIdFromConfig,
        nowEpochMs,
      };
      const agent = new PiObject(options);
      source = { agent, options };
      return agent;
    },
  };
  try {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "PostHog generation replay after a restart",
        options: { drain: false },
        objects: { ...allLocalObjects, ...objects },
        piAvailableModels: PI_SCENARIO_AVAILABLE_MODELS,
        setup: ({ given }) => [
          given.auth.user({ id: "alice" }),
          given.auth.organization({ id: "north", ownerUserId: "alice" }),
        ],
        steps: ({ then }) => [
          then.assert("the replay reports the same generation again", async ({ runtime }) => {
            await prompt(
              runtime,
              createBackofficeUserExecution({ scope: north, userId: "alice" }),
              "replayed",
            );
            await runtime.drain();
            assert.equal(captured.length, 1);
            const original = source;
            assert(original !== null);
            await original.agent.close();
            const restored = new PiObject({
              ...original.options,
              openStorage: async () => await openNodeSqliteStorage(snapshot),
            });
            try {
              await restored.alarm();
              await runtime.drain();
            } finally {
              await restored.close();
            }
            expect(captured).toHaveLength(2);
            expect(captured[1]).toEqual(captured[0]);
          }),
          then.assert("PostHog's deduplicated usage equals the ledger", async ({ runtime }) => {
            expect(await ledgerTokens(runtime, north)).toEqual(reportedTokens(captured));
            const period = new Date(runtime.now()).toISOString().slice(0, 7);
            const { trackers } = await runtime.objects.billing
              .for(north)
              .commands.getStatement({ period });
            expect(trackers.find((tracker) => tracker.meter === "ai.tokens.total")).toMatchObject({
              eventCount: "1",
            });
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
