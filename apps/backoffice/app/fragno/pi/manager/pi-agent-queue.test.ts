import { assert, expect, onTestFinished, test } from "vitest";

import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import type { PiAgent, PiAgentPrompt, PiAgentTurn } from "@/fragno/pi/agent/pi-agent-contract";

import { piManagerConversationRoutes } from "./pi-manager-conversation-routes";
import { piManagerDefinition } from "./pi-manager-definition";
import { piManagerDirectoryRoutes } from "./pi-manager-directory-routes";
import { reportPiAgentTurnSettled } from "./pi-manager-fragment";
import { piManagerTurnRoutes } from "./pi-manager-turn-routes";

const ORG_SCOPE: BackofficeContextScope = { kind: "org", orgId: "queue-org" };
const AVAILABLE_MODELS = [
  { provider: "faux", modelId: "faux-1", label: "Faux 1", contextWindow: 128_000 },
] as const;

type PromptInput = {
  requestId: string;
  sender?: string;
  whenBusy?: "followUp" | "steer" | "reject";
  agentName?: string;
  billingOrganizationId?: string | null;
};

/** What the agent object received: how, which request, and the instructions it runs under. */
type Handover = { via: "steer" | "dispatch"; requestId: string; instructions: string };

function unused(): never {
  throw new Error("The queue tests use only steer and dispatch.");
}

/**
 * The manager over in-memory SQLite, with an agent object that records each handover and settles
 * only when a test reports it, as a real agent's outbox does.
 */
async function piManagerQueue(scope: BackofficeContextScope = ORG_SCOPE) {
  const handovers: Handover[] = [];
  const failing = { handovers: 0 };
  function receive(via: Handover["via"]) {
    return async (_config: PiAgentConfig, turn: PiAgentTurn, prompt: PiAgentPrompt) => {
      if (failing.handovers > 0) {
        failing.handovers -= 1;
        throw new Error("The agent object is unavailable.");
      }
      handovers.push({ via, requestId: prompt.requestId, instructions: turn.agent.instructions });
    };
  }
  const agent: PiAgent = {
    warm: unused,
    steer: receive("steer"),
    dispatch: receive("dispatch"),
    // Pi has no submissions of its own here, so lookups read the queue's records.
    getSubmission: async () => null,
    waitForSubmission: async () => ({ status: "pending", submission: null }),
    getView: unused,
    watchView: unused,
    listEntries: unused,
    exportEntries: unused,
    notify: unused,
    compact: unused,
    getCompaction: unused,
    abort: async () => undefined,
  };
  const config = {
    scope,
    agent: () => agent,
    supportedAvailableModels: async () => AVAILABLE_MODELS,
  };
  const { fragments, test: database } = await buildDatabaseFragmentsTest()
    .withTestAdapter({ type: "kysely-sqlite" })
    .withFragment(
      "piManager",
      instantiate(piManagerDefinition)
        .withConfig(config)
        .withRoutes([piManagerDirectoryRoutes, piManagerTurnRoutes, piManagerConversationRoutes]),
    )
    .build();
  onTestFinished(async () => {
    await database.cleanup();
  });
  const { fragment } = fragments.piManager;

  function provenance(sender: string) {
    const { actors } = createBackofficeServiceExecution({
      scope,
      service: { type: "automation", id: sender },
    });
    return { actors, scopeRestriction: null };
  }

  return {
    fragment,
    handovers,
    failing,
    async prompt(input: PromptInput) {
      const { agentName = "assistant", sender = "ada", ...prompt } = input;
      return await fragment.callRoute("POST", "/agents/:agentName/prompts", {
        pathParams: { agentName },
        body: {
          requestId: prompt.requestId,
          content: `Prompt ${prompt.requestId}.`,
          whenBusy: prompt.whenBusy ?? "followUp",
          billingOrganizationId: prompt.billingOrganizationId ?? null,
          provenance: provenance(sender),
        },
      });
    },
    async receipt(input: PromptInput) {
      const response = await this.prompt(input);
      assert(response.type === "json", JSON.stringify(response));
      return response.data;
    },
    async settle(requestId: string, agentName = "assistant") {
      await reportPiAgentTurnSettled(fragment, config, { agentName, requestId });
    },
    async submission(requestId: string, agentName = "assistant") {
      const response = await fragment.callRoute(
        "GET",
        "/agents/:agentName/submissions/:requestId",
        { pathParams: { agentName, requestId } },
      );
      return response.type === "json" ? response.data : response.type;
    },
    requestIds() {
      return handovers.map(({ via, requestId }) => `${via} ${requestId}`);
    },
  };
}

test("an agent runs its queue one turn at a time, in arrival order", async () => {
  const queue = await piManagerQueue();

  // An idle agent receives its first prompt at once; later ones wait behind it.
  for (const requestId of ["first", "second", "third"]) {
    expect(await queue.receipt({ requestId })).toEqual({ requestId, status: "queued" });
  }
  expect(queue.requestIds()).toEqual(["dispatch first"]);
  expect(await queue.submission("third")).toEqual({
    type: "input",
    status: "queued",
    requestId: "third",
  });

  await queue.settle("first");
  expect(queue.requestIds()).toEqual(["dispatch first", "dispatch second"]);
  await queue.settle("second");
  await queue.settle("third");
  expect(queue.requestIds()).toEqual(["dispatch first", "dispatch second", "dispatch third"]);

  // A settlement reported again, or one the queue never placed, hands nothing over.
  await queue.settle("third");
  await queue.settle("route:orders:event-1");
  expect(queue.handovers).toHaveLength(3);
  expect(await queue.receipt({ requestId: "fourth" })).toEqual({
    requestId: "fourth",
    status: "queued",
  });
  assert(queue.requestIds().at(-1) === "dispatch fourth");
});

test("a steer joins only a running turn of the same sender, and a rejectable prompt only an idle agent", async () => {
  const queue = await piManagerQueue();

  // Nothing runs to join yet, so the first steer runs as a turn of its own.
  expect(await queue.receipt({ requestId: "ada-first", whenBusy: "steer" })).toEqual({
    requestId: "ada-first",
    status: "queued",
  });
  expect(
    await queue.receipt({ requestId: "grace-steer", sender: "grace", whenBusy: "steer" }),
  ).toEqual({ requestId: "grace-steer", status: "queued" });
  expect(await queue.receipt({ requestId: "ada-steer", whenBusy: "steer" })).toEqual({
    requestId: "ada-steer",
    status: "steered",
  });
  const rejected = await queue.prompt({ requestId: "ada-reject", whenBusy: "reject" });
  assert(rejected.type === "error");
  assert(rejected.error.code === "AGENT_BUSY");
  expect(queue.requestIds()).toEqual(["dispatch ada-first", "steer ada-steer"]);

  // The steer settles with the turn it joined; only that turn's settlement moves the queue.
  await queue.settle("ada-steer");
  expect(queue.handovers).toHaveLength(2);
  await queue.settle("ada-first");
  assert(queue.requestIds().at(-1) === "dispatch grace-steer");
  await queue.settle("grace-steer");

  // A rejected prompt was never recorded, so its request ID runs once the agent is idle.
  expect(await queue.receipt({ requestId: "ada-reject", whenBusy: "reject" })).toEqual({
    requestId: "ada-reject",
    status: "queued",
  });
  assert(queue.requestIds().at(-1) === "dispatch ada-reject");
});

test("a resent request ID keeps its first placement and is never handed over twice", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "first" });
  await queue.receipt({ requestId: "steered", whenBusy: "steer" });
  await queue.receipt({ requestId: "waiting" });

  // Resent while queued, while steering, and after settling, with a different mode each time.
  expect(await queue.receipt({ requestId: "waiting", whenBusy: "steer" })).toEqual({
    requestId: "waiting",
    status: "queued",
  });
  expect(await queue.receipt({ requestId: "steered" })).toEqual({
    requestId: "steered",
    status: "steered",
  });
  await queue.settle("steered");
  await queue.settle("first");
  await queue.settle("waiting");
  expect(await queue.receipt({ requestId: "first", whenBusy: "reject" })).toEqual({
    requestId: "first",
    status: "queued",
  });
  expect(queue.requestIds()).toEqual(["dispatch first", "steer steered", "dispatch waiting"]);
});

test("waiting prompts run under the definition as it is when their turn starts, and are dropped once it is gone", async () => {
  const queue = await piManagerQueue();
  const clerk = {
    description: "Answers in turn.",
    model: null,
    permissions: ["*"],
    managedBy: null,
  };
  const created = await queue.fragment.callRoute("POST", "/agents", {
    body: { agentName: "clerk", ...clerk, instructions: "Version one." },
  });
  assert(created.type === "json");
  for (const requestId of ["first", "second", "third"]) {
    await queue.receipt({ requestId, agentName: "clerk" });
  }

  const edited = await queue.fragment.callRoute("PUT", "/agents/:agentName", {
    pathParams: { agentName: "clerk" },
    body: { ...clerk, instructions: "Version two." },
  });
  assert(edited.type === "json");
  await queue.settle("first", "clerk");
  expect(queue.handovers.map(({ requestId, instructions }) => [requestId, instructions])).toEqual([
    ["first", "Version one."],
    ["second", "Version two."],
  ]);

  const deleted = await queue.fragment.callRoute("DELETE", "/agents/:agentName", {
    pathParams: { agentName: "clerk" },
  });
  assert(deleted.type === "empty");
  await queue.settle("second", "clerk");
  expect(queue.handovers).toHaveLength(2);
  expect(await queue.submission("third", "clerk")).toEqual({
    type: "input",
    status: "dropped",
    requestId: "third",
    reason: "Pi agent 'clerk' is not defined.",
  });
});

test("aborting drops what waits and keeps the running turn", async () => {
  const queue = await piManagerQueue();
  for (const requestId of ["running", "waiting"]) {
    await queue.receipt({ requestId });
  }
  const aborted = await queue.fragment.callRoute("POST", "/agents/:agentName/abort", {
    pathParams: { agentName: "assistant" },
  });
  assert(aborted.type === "empty");
  expect(await queue.submission("waiting")).toEqual({
    type: "input",
    status: "dropped",
    requestId: "waiting",
    reason: "The agent was aborted before this prompt ran.",
  });

  // The aborted turn settles unanswered; nothing is left to run after it.
  await queue.settle("running");
  expect(queue.requestIds()).toEqual(["dispatch running"]);
  await queue.receipt({ requestId: "after" });
  expect(queue.requestIds()).toEqual(["dispatch running", "dispatch after"]);
});

test("a personal agent's first prompt needs a billing owner and records nothing without one", async () => {
  const queue = await piManagerQueue({ kind: "user", userId: "user-1" });
  const refused = await queue.prompt({ requestId: "first" });
  assert(refused.type === "error");
  assert(refused.error.code === "PI_BILLING_OWNER_REQUIRED");
  assert((await queue.submission("first")) === "error");

  expect(await queue.receipt({ requestId: "first", billingOrganizationId: "org-1" })).toEqual({
    requestId: "first",
    status: "queued",
  });
  expect(queue.requestIds()).toEqual(["dispatch first"]);
});

test("the queue's hook hands over again what a failed request did not", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "first" });
  queue.failing.handovers = 2;
  // Each submission is recorded before its handover fails.
  expect(await queue.receipt({ requestId: "steered", whenBusy: "steer" })).toEqual({
    requestId: "steered",
    status: "steered",
  });
  await queue.settle("first");
  await queue.receipt({ requestId: "next" });
  queue.failing.handovers = 0;
  expect(queue.requestIds()).toEqual(["dispatch first"]);

  await drainDurableHooks(queue.fragment);
  // Every hook run hands over each unsettled item; the agent object keeps the first submission.
  expect(new Set(queue.requestIds())).toEqual(
    new Set(["dispatch first", "steer steered", "dispatch next"]),
  );
});

test("concurrent prompts to an idle agent dispatch exactly one of them", async () => {
  const queue = await piManagerQueue();
  async function race(requestIds: readonly string[]) {
    const receipts = await Promise.all(requestIds.map((requestId) => queue.receipt({ requestId })));
    expect(receipts.map(({ status }) => status)).toEqual(requestIds.map(() => "queued"));
    expect(queue.handovers).toHaveLength(1);
    const [running] = queue.handovers;
    await queue.settle(running.requestId);
    expect(new Set(queue.handovers.map(({ requestId }) => requestId))).toEqual(new Set(requestIds));
    for (const { requestId } of queue.handovers) {
      await queue.settle(requestId);
    }
    queue.handovers.length = 0;
  }

  // The first prompts both provision the agent; later ones race on the queue's revision.
  await race(["left", "right"]);
  await race(["up", "down"]);
});
