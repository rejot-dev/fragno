import { assert, expect, onTestFinished, test } from "vitest";

import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import { instantiate } from "@fragno-dev/core";
import { buildDatabaseFragmentsTest, drainDurableHooks } from "@fragno-dev/test";

import type { SubmissionRecord } from "@earendil-works/pi-durable";

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import { appendAutomationDelegate } from "@/fragno/automation/authority";
import { piAgentActor } from "@/fragno/pi/agent/pi-agent-actor";
import type {
  PiAgent,
  PiAgentAddress,
  PiAgentNotification,
  PiAgentPrompt,
  PiAgentSteer,
  PiAgentTurn,
  PiAgentWaitingQueue,
  PiQueuedSubagent,
  PiAgentWork,
} from "@/fragno/pi/agent/pi-agent-contract";
import { piNotificationRequestId } from "@/fragno/pi/agent/pi-agent-notification-entry";

import { piManagerConversationRoutes } from "./pi-manager-conversation-routes";
import { piManagerDefinition, type PiManagerConfig } from "./pi-manager-definition";
import { piManagerDirectoryRoutes } from "./pi-manager-directory-routes";
import { reportPiAgentTurnSettled } from "./pi-manager-fragment";
import { piManagerTurnRoutes } from "./pi-manager-turn-routes";

const ORG_SCOPE: BackofficeContextScope = { kind: "org", orgId: "queue-org", jurisdiction: null };
const AVAILABLE_MODELS = [
  {
    provider: "faux",
    modelId: "faux-1",
    label: "Faux 1",
    contextWindow: 128_000,
    thinkingLevels: ["off"],
  },
] as const;

type PromptInput = {
  requestId: string;
  sender?: string;
  /** The agent whose turn sends the prompt for the sender. */
  sendingAgent?: PiAgentConfig;
  replyTo?: PiAgentConfig;
  whenBusy?: "followUp" | "steer" | "reject";
  whenPaused?: "wait" | "resume";
  agentName?: string;
  /** Runs the prompt in a new conversation of the agent. */
  subagent?: boolean;
};

/** What the manager delivered to an agent a prompt replies to, and as whom. */
type Reply = { agent: PiAgentConfig; delegation: string[]; event: Record<string, unknown> };

type NotificationInput = {
  eventId: string;
  sender?: string;
  routeId?: string | null;
  agentName?: string;
};

/**
 * What the agent object received: how, which request, and the events of the notifications it
 * handles or writes. A write runs no turn, so it has no instructions.
 */
type Handover = {
  via: "steer" | "dispatch" | "subagent" | "write";
  requestId: string;
  instructions: string | null;
  events: string[];
};

function unused(): never {
  throw new Error("The queue tests use only the queue's operations.");
}

/**
 * The manager over in-memory SQLite, with an agent object that records each handover and settles
 * only when a test reports it, as a real agent's outbox does.
 */
async function piManagerQueue(scope: BackofficeContextScope = ORG_SCOPE) {
  const handovers: Handover[] = [];
  // Like Pi, the fake keeps the first submission of each request ID it receives.
  const submissions = new Map<string, SubmissionRecord>();
  const failing = { handovers: 0, publications: 0 };
  // The latest queue each agent was shown, as the agent object keeps it.
  const published = new Map<string, PiAgentWaitingQueue>();
  const replies: Reply[] = [];
  // What the agent knows of each subagent, as `awaitSubagents` reads it.
  const subagents = new Map<string, string>();
  function receive(handover: Handover) {
    if (failing.handovers > 0) {
      failing.handovers -= 1;
      throw new Error("The agent object is unavailable.");
    }
    handovers.push(handover);
    if (handover.via !== "write" && !submissions.has(handover.requestId)) {
      submissions.set(handover.requestId, {
        id: submissions.size + 1,
        conversationId: 1,
        requestId: handover.requestId,
        type: "input",
        status: "placed",
      } as unknown as SubmissionRecord);
    }
  }
  // Like an agent object, each agent keeps only the newest queue published to it.
  async function publishQueue(agentName: string, queue: PiAgentWaitingQueue) {
    if (failing.publications > 0) {
      failing.publications -= 1;
      throw new Error("The agent object is unavailable.");
    }
    const current = published.get(agentName);
    if (!current || current.revision < queue.revision) {
      published.set(agentName, queue);
    }
  }
  const agent: Omit<PiAgent, "publishQueue"> = {
    warm: unused,
    async steer(_config: PiAgentConfig, _revision: number, turn: PiAgentTurn, steer: PiAgentSteer) {
      receive({
        via: "steer",
        requestId:
          steer.type === "prompt" ? steer.requestId : piNotificationRequestId(steer.notification),
        instructions: turn.agent.instructions,
        events: steer.type === "prompt" ? [] : [steer.notification.event.id],
      });
    },
    async startSubagent(
      _config: PiAgentConfig,
      _revision: number,
      turn: PiAgentTurn,
      prompt: PiAgentPrompt,
    ) {
      receive({
        via: "subagent",
        requestId: prompt.requestId,
        instructions: turn.agent.instructions,
        events: [],
      });
      subagents.set(prompt.requestId, "started");
    },
    async recordSubagent(_config: PiAgentConfig, requestId: string, subagent: PiQueuedSubagent) {
      if (failing.handovers > 0) {
        failing.handovers -= 1;
        throw new Error("The agent object is unavailable.");
      }
      if (subagents.get(requestId) !== "started") {
        subagents.set(
          requestId,
          subagent.status === "dropped" ? `dropped: ${subagent.reason}` : subagent.status,
        );
      }
    },
    async dispatch(
      _config: PiAgentConfig,
      _revision: number,
      turn: PiAgentTurn,
      work: PiAgentWork,
    ) {
      receive({
        via: "dispatch",
        requestId: work.requestId,
        instructions: turn.agent.instructions,
        events:
          work.type === "notifications" ? work.notifications.map(({ event }) => event.id) : [],
      });
    },
    async writeNotifications(_config: PiAgentConfig, notifications: PiAgentNotification[]) {
      receive({
        via: "write",
        requestId: notifications.map(piNotificationRequestId).join(" "),
        instructions: null,
        events: notifications.map(({ event }) => event.id),
      });
    },
    getSubmission: async (_config, requestId) => {
      const record = submissions.get(requestId);
      return record ? { record, answer: null } : null;
    },
    getSubagentRuns: async (_config, requestIds) =>
      requestIds.map((requestId) => ({
        requestId,
        submission: submissions.get(requestId) ?? null,
        startedAt: null,
        answeredAt: null,
        answer: null,
      })),
    getView: unused,
    fetch: unused,
    listEntries: unused,
    listMessages: unused,
    exportEntries: unused,
    compact: unused,
    getCompaction: unused,
    reset: unused,
    abort: async () => undefined,
  };
  const config = {
    scope,
    agent: ({ agentName }: PiAgentAddress): PiAgent => ({
      ...agent,
      publishQueue: async (queue) => await publishQueue(agentName, queue),
    }),
    supportedAvailableModels: async () => AVAILABLE_MODELS,
    // Queue tests record no usage, so nothing limits their prompts.
    billing: () => ({ kind: "system" as const }),
    automations: null,
    notifyAgent: async ({
      agent,
      provenance,
      event,
    }: Parameters<PiManagerConfig["notifyAgent"]>[0]) => {
      const delegation = provenance.actors.delegation.map(({ id }) => id);
      replies.push({ agent, delegation, event });
    },
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

  function provenance(sender: string, sendingAgent?: PiAgentConfig) {
    const execution = createBackofficeServiceExecution({
      scope,
      service: { type: "automation", id: sender },
    });
    const { actors } = sendingAgent
      ? appendAutomationDelegate({
          execution,
          delegate: piAgentActor(sendingAgent.scope, sendingAgent.agentName),
        })
      : execution;
    return { actors, scopeRestriction: null };
  }

  /** The event a real agent records for an answered turn and reports with its settlement. */
  function completedTurn(agentName: string, requestId: string): AutomationEvent {
    return {
      id: `pi:${agentName}:ended:${requestId}`,
      scope,
      scopeRestriction: null,
      source: "pi",
      eventType: "turn.completed",
      payload: { answerEntryId: 7 },
      occurredAt: "2026-01-01T00:00:00.000Z",
      actors: provenance("ada").actors,
      subject: { scope, agentName, requestId },
      causation: { kind: "origin" },
    };
  }

  return {
    fragment,
    provenance,
    handovers,
    replies,
    subagents,
    failing,
    async prompt(input: PromptInput) {
      const { agentName = "assistant", sender = "ada", sendingAgent, ...prompt } = input;
      return await fragment.callRoute("POST", "/agents/:agentName/prompts", {
        pathParams: { agentName },
        body: {
          requestId: prompt.requestId,
          content: `Prompt ${prompt.requestId}.`,
          subagent: prompt.subagent ?? false,
          whenBusy: prompt.whenBusy ?? "followUp",
          whenPaused: prompt.whenPaused ?? "wait",
          model: null,
          replyTo: prompt.replyTo ?? null,
          askingToolCall: null,
          provenance: provenance(sender, sendingAgent),
        },
      });
    },
    async receipt(input: PromptInput) {
      const response = await this.prompt(input);
      assert(response.type === "json", JSON.stringify(response));
      return response.data;
    },
    async notify(input: NotificationInput) {
      const { agentName = "assistant", sender = "ada", eventId } = input;
      return await fragment.callRoute("POST", "/agents/:agentName/notifications", {
        pathParams: { agentName },
        body: {
          routeId: input.routeId === undefined ? "orders" : input.routeId,
          event: {
            id: eventId,
            source: "shop",
            eventType: "order.placed",
            occurredAt: "2026-01-01T00:00:00.000Z",
            subject: null,
            payload: {},
          },
          provenance: provenance(sender),
        },
      });
    },
    async delivered(input: NotificationInput) {
      const response = await this.notify(input);
      assert(response.type === "empty", JSON.stringify(response));
    },
    async control(action: "stop" | "resume", agentName = "assistant") {
      const response =
        action === "stop"
          ? await fragment.callRoute("POST", "/agents/:agentName/stop", {
              pathParams: { agentName },
              body: { provenance: provenance("ada") },
            })
          : await fragment.callRoute("POST", "/agents/:agentName/resume", {
              pathParams: { agentName },
              body: { provenance: provenance("ada") },
            });
      assert(response.type === "empty", JSON.stringify(response));
    },
    /** What the agent was last shown of its queue, as `<type> <requestId>` lines, led by `paused`. */
    publishedQueue(agentName = "assistant") {
      const queue = published.get(agentName);
      assert(queue, `Nothing was published to ${agentName}.`);
      return [
        ...(queue.paused ? ["paused"] : []),
        ...queue.items.map(({ type, requestId }) => `${type} ${requestId}`),
      ];
    },
    async settle(requestId: string, agentName = "assistant") {
      await reportPiAgentTurnSettled(fragment, config, {
        agentName,
        requestId,
        ended: completedTurn(agentName, requestId),
      });
    },
    async submission(requestId: string, agentName = "assistant") {
      const response = await fragment.callRoute("GET", "/agents/:agentName/prompts/:requestId", {
        pathParams: { agentName, requestId },
      });
      return response.type === "json" ? response.data : response.type;
    },
    /** The agent's subagents as its page lists them, as `<status> <requestId>` lines. */
    async listedSubagents(agentName = "assistant") {
      const response = await fragment.callRoute("GET", "/agents/:agentName/subagents", {
        pathParams: { agentName },
      });
      assert(response.type === "json", JSON.stringify(response));
      return response.data.subagents.map(
        ({ requestId, status }) => `${status.status} ${requestId}`,
      );
    },
    /** Handovers that run turns, leaving out the cards written as notifications arrive. */
    turns() {
      return this.requestIds().filter((handover) => !handover.startsWith("write "));
    },
    requestIds() {
      return handovers.map(
        ({ via, requestId, events }) =>
          `${via} ${requestId}${events.length > 0 ? ` (${events.join(", ")})` : ""}`,
      );
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
  expect(await queue.submission("third")).toEqual({ requestId: "third", status: "queued" });

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
  };
  const created = await queue.fragment.callRoute("POST", "/agents", {
    body: {
      agentName: "clerk",
      ...clerk,
      instructions: "Version one.",
      provenance: queue.provenance("ada"),
    },
  });
  assert(created.type === "json");
  for (const requestId of ["first", "second", "third"]) {
    await queue.receipt({ requestId, agentName: "clerk" });
  }

  const edited = await queue.fragment.callRoute("PUT", "/agents/:agentName", {
    pathParams: { agentName: "clerk" },
    body: { ...clerk, instructions: "Version two.", provenance: queue.provenance("ada") },
  });
  assert(edited.type === "json");
  await queue.settle("first", "clerk");
  expect(queue.handovers.map(({ requestId, instructions }) => [requestId, instructions])).toEqual([
    ["first", "Version one."],
    ["second", "Version two."],
  ]);

  const deleted = await queue.fragment.callRoute("DELETE", "/agents/:agentName", {
    pathParams: { agentName: "clerk" },
    body: { provenance: queue.provenance("ada") },
  });
  assert(deleted.type === "empty");
  await queue.settle("second", "clerk");
  expect(queue.handovers).toHaveLength(2);
  expect(await queue.submission("third", "clerk")).toEqual({
    requestId: "third",
    status: "failed",
    reason: "Pi agent 'clerk' is not defined.",
  });
});

test("an agent of another scope hears how the prompts it asked about end, settled or dropped", async () => {
  const queue = await piManagerQueue();
  const planner: PiAgentConfig = {
    scope: { kind: "user", userId: "ada", jurisdiction: null },
    agentName: "planner",
  };
  const created = await queue.fragment.callRoute("POST", "/agents", {
    body: {
      agentName: "clerk",
      description: "Answers in turn.",
      model: null,
      permissions: ["*"],
      instructions: "Answer.",
      provenance: queue.provenance("ada"),
    },
  });
  assert(created.type === "json");

  // Only the agent's own turn names it; anyone else asking for its reply is refused.
  const forged = await queue.prompt({ requestId: "forged", agentName: "clerk", replyTo: planner });
  assert(forged.type === "error" && forged.error.code === "REPLY_NOT_ALLOWED");
  // An agent is not told of its own prompts; one of the same name in another scope is.
  const clerk = { scope: ORG_SCOPE, agentName: "clerk" };
  const namesake = { scope: planner.scope, agentName: "clerk" };
  const own = await queue.prompt({
    requestId: "own",
    agentName: "clerk",
    sendingAgent: clerk,
    replyTo: clerk,
  });
  assert(own.type === "error" && own.error.code === "REPLY_NOT_ALLOWED");

  for (const [requestId, sendingAgent, replyTo] of [
    ["asked", planner, planner],
    ["unasked", planner, undefined],
    ["doomed", namesake, namesake],
  ] as const) {
    await queue.receipt({ requestId, agentName: "clerk", sendingAgent, replyTo });
  }
  const deleted = await queue.fragment.callRoute("DELETE", "/agents/:agentName", {
    pathParams: { agentName: "clerk" },
    body: { provenance: queue.provenance("ada") },
  });
  assert(deleted.type === "empty");
  // The answered turn replies, and its settlement drops the prompts waiting behind it.
  await queue.settle("asked", "clerk");
  await drainDurableHooks(queue.fragment);

  expect(queue.replies).toEqual([
    {
      agent: planner,
      delegation: [piAgentActor(planner.scope, planner.agentName).id],
      event: {
        id: expect.any(String),
        source: "pi",
        eventType: "turn.completed",
        occurredAt: "2026-01-01T00:00:00.000Z",
        subject: { scope: ORG_SCOPE, agentName: "clerk", requestId: "asked" },
        payload: { answerEntryId: 7 },
      },
    },
    {
      agent: namesake,
      delegation: [piAgentActor(namesake.scope, namesake.agentName).id],
      event: expect.objectContaining({
        source: "pi",
        eventType: "queue.dropped",
        subject: { scope: ORG_SCOPE, agentName: "clerk", requestId: "doomed" },
        payload: { reason: "Pi agent 'clerk' is not defined." },
      }),
    },
  ]);
});

test("subagents run beside the agent's own turns, a few at a time, and wait while it is stopped", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "own" });
  for (const requestId of ["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"]) {
    expect(await queue.receipt({ requestId, subagent: true })).toEqual({
      requestId,
      status: "queued",
    });
  }
  // The agent's own turn holds no subagent back, but only four run at once.
  expect(queue.turns()).toEqual([
    "dispatch own",
    "subagent doc-1",
    "subagent doc-2",
    "subagent doc-3",
    "subagent doc-4",
  ]);
  // A waiting subagent waits for a slot, not in the agent's conversation.
  expect(queue.publishedQueue()).toEqual([]);
  expect(await queue.submission("doc-5")).toEqual({ requestId: "doc-5", status: "queued" });
  // A subagent's conversation is new, so it never steers or is refused as busy.
  const steering = await queue.prompt({
    requestId: "doc-steer",
    subagent: true,
    whenBusy: "steer",
  });
  assert(steering.type === "error" && steering.error.code === "SUBAGENT_NOT_BUSY");

  // A subagent that ends frees its slot for the oldest waiting one; the agent's queue stays.
  await queue.settle("doc-2");
  assert(queue.turns().at(-1) === "subagent doc-5");
  await queue.settle("own");
  // Running subagents leave the agent itself idle.
  await queue.receipt({ requestId: "idle", whenBusy: "reject" });
  assert(queue.turns().at(-1) === "dispatch idle");

  // Stopping holds new subagents until someone resumes the agent.
  await queue.control("stop");
  await queue.receipt({ requestId: "doc-6", subagent: true });
  await queue.settle("doc-1");
  assert(queue.turns().at(-1) === "dispatch idle");
  await queue.control("resume");
  assert(queue.turns().at(-1) === "subagent doc-6");

  // Handovers that failed, telling the agent of a subagent and starting it, are made again by
  // the queue's hooks.
  queue.failing.handovers = 2;
  await queue.settle("doc-3");
  // The agent could not hear of it, so its request ID is not returned.
  const unheard = await queue.prompt({ requestId: "doc-7", subagent: true });
  assert(unheard.type === "error" && unheard.error.code === "AGENT_UNAVAILABLE");
  assert(!queue.subagents.has("doc-7"));
  await drainDurableHooks(queue.fragment);
  expect(queue.turns()).toContain("subagent doc-7");
  assert(queue.subagents.get("doc-7") === "started");
});

test("an agent knows of each subagent from when it is queued until it starts or is dropped", async () => {
  const queue = await piManagerQueue();
  const clerk = { description: "Checks documents.", model: null, permissions: ["*"] };
  const created = await queue.fragment.callRoute("POST", "/agents", {
    body: {
      agentName: "clerk",
      ...clerk,
      instructions: "Check it.",
      provenance: queue.provenance("ada"),
    },
  });
  assert(created.type === "json");
  for (const requestId of ["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"]) {
    await queue.receipt({ requestId, agentName: "clerk", subagent: true });
  }
  expect(Object.fromEntries(queue.subagents)).toEqual({
    "doc-1": "started",
    "doc-2": "started",
    "doc-3": "started",
    "doc-4": "started",
    "doc-5": "waiting",
  });

  // Its request ID is returned only once its agent knows of it; the same ID retried tells it.
  queue.failing.handovers = 1;
  const unheard = await queue.prompt({ requestId: "doc-6", agentName: "clerk", subagent: true });
  assert(unheard.type === "error" && unheard.error.code === "AGENT_UNAVAILABLE");
  assert(!queue.subagents.has("doc-6"));
  await queue.receipt({ requestId: "doc-6", agentName: "clerk", subagent: true });
  assert(queue.subagents.get("doc-6") === "waiting");

  // One that waited for a slot is dropped once its definition is gone, and its agent hears so.
  const deleted = await queue.fragment.callRoute("DELETE", "/agents/:agentName", {
    pathParams: { agentName: "clerk" },
    body: { provenance: queue.provenance("ada") },
  });
  assert(deleted.type === "empty");
  await queue.settle("doc-1", "clerk");
  assert(queue.subagents.get("doc-5") === "dropped: Pi agent 'clerk' is not defined.");
  assert(queue.subagents.get("doc-6") === "dropped: Pi agent 'clerk' is not defined.");
});

test("a subagent prompt that resumes a stopped agent resumes its own conversation too", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "running" });
  await queue.receipt({ requestId: "waiting" });
  await queue.control("stop");
  await queue.settle("running");
  await queue.receipt({ requestId: "doc-1", subagent: true, whenPaused: "resume" });
  expect(queue.turns()).toEqual(["dispatch running", "dispatch waiting", "subagent doc-1"]);
});

test("only an agent's own turn starts subagents from its tool calls", async () => {
  const queue = await piManagerQueue();
  const prompt = (sendingAgent: PiAgentConfig | undefined) =>
    queue.fragment.callRoute("POST", "/agents/:agentName/prompts", {
      pathParams: { agentName: "assistant" },
      body: {
        requestId: `doc-${sendingAgent?.agentName ?? "person"}`,
        content: "Check it.",
        subagent: true,
        whenBusy: "followUp",
        whenPaused: "wait",
        model: null,
        replyTo: null,
        askingToolCall: "call-1",
        provenance: queue.provenance("ada", sendingAgent),
      },
    });
  const fromPerson = await prompt(undefined);
  assert(fromPerson.type === "error" && fromPerson.error.code === "ASKING_TOOL_CALL_NOT_ALLOWED");
  const fromOther = await prompt({ scope: ORG_SCOPE, agentName: "researcher" });
  assert(fromOther.type === "error" && fromOther.error.code === "ASKING_TOOL_CALL_NOT_ALLOWED");
  const fromItself = await prompt({ scope: ORG_SCOPE, agentName: "assistant" });
  assert(fromItself.type === "json", JSON.stringify(fromItself));
});

test("an agent hears back from the subagents it starts of itself", async () => {
  const queue = await piManagerQueue();
  const assistant = { scope: ORG_SCOPE, agentName: "assistant" };
  await queue.receipt({
    requestId: "doc-1",
    subagent: true,
    sendingAgent: assistant,
    replyTo: assistant,
  });
  await queue.settle("doc-1");
  await drainDurableHooks(queue.fragment);

  expect(queue.replies).toEqual([
    expect.objectContaining({
      agent: assistant,
      event: expect.objectContaining({
        eventType: "turn.completed",
        subject: { scope: ORG_SCOPE, agentName: "assistant", requestId: "doc-1" },
      }),
    }),
  ]);
});

test("stopping pauses the queue until someone sends a message, which joins its end", async () => {
  const queue = await piManagerQueue();
  for (const requestId of ["running", "waiting"]) {
    await queue.receipt({ requestId });
  }
  await queue.control("stop");
  // The stopped turn settles unanswered, and nothing starts after it.
  await queue.settle("running");
  expect(await queue.submission("waiting")).toEqual({ requestId: "waiting", status: "queued" });
  // Nothing runs, but work waits, so a rejectable prompt is refused.
  const rejected = await queue.prompt({ requestId: "impatient", whenBusy: "reject" });
  assert(rejected.type === "error" && rejected.error.code === "AGENT_BUSY");

  // While paused, automations wait even for an idle agent; an event's card is still written.
  await queue.receipt({ requestId: "automated", sender: "grace" });
  await queue.delivered({ eventId: "ada-1" });
  expect(queue.requestIds()).toEqual(["dispatch running", "write route:orders:ada-1 (ada-1)"]);

  // A message resumes the queue, which starts with its oldest item, not the message.
  await queue.receipt({ requestId: "message", whenBusy: "steer", whenPaused: "resume" });
  await queue.settle("waiting");
  await queue.settle("automated");
  await queue.settle("route:orders:ada-1");
  expect(queue.turns()).toEqual([
    "dispatch running",
    "dispatch waiting",
    "dispatch automated",
    "dispatch route:orders:ada-1 (ada-1)",
    "dispatch message",
  ]);
});

test("resuming starts the next turn at once, or when the stopped turn settles", async () => {
  const queue = await piManagerQueue();
  for (const requestId of ["first", "second", "third"]) {
    await queue.receipt({ requestId });
  }
  await queue.control("stop");
  await queue.settle("first");
  await queue.control("resume");
  expect(queue.turns()).toEqual(["dispatch first", "dispatch second"]);

  await queue.control("stop");
  await queue.control("resume");
  expect(queue.turns()).toHaveLength(2);
  await queue.settle("second");
  assert(queue.turns().at(-1) === "dispatch third");
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
  queue.failing.handovers = 1;
  await queue.delivered({ eventId: "ada-1" });
  expect(queue.requestIds()).toEqual(["dispatch first"]);

  await drainDurableHooks(queue.fragment);
  // Every hook run hands over each unsettled item; the agent object keeps the first submission.
  expect(new Set(queue.requestIds())).toEqual(
    new Set([
      "dispatch first",
      "steer steered",
      "dispatch next",
      "steer route:orders:ada-1 (ada-1)",
    ]),
  );
});

test("an agent's subagents list those running however many newer ones wait", async () => {
  const queue = await piManagerQueue();

  for (let index = 1; index <= 54; index += 1) {
    await queue.receipt({ requestId: `task-${index}`, subagent: true });
  }

  // The latest are the 50 that wait; the four that run, older than them, are listed after them.
  const listed = await queue.listedSubagents();
  assert(listed.slice(0, 50).every((line) => line.startsWith("queued ")));
  expect(listed.slice(50)).toEqual([
    "running task-4",
    "running task-3",
    "running task-2",
    "running task-1",
  ]);
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

test("events are written as they arrive, and a sender's waiting requests share one turn", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "first", sender: "linus" });
  await queue.delivered({ eventId: "ada-1" });
  await queue.delivered({ eventId: "grace-1", sender: "grace" });
  await queue.delivered({ eventId: "ada-2" });
  await queue.receipt({ requestId: "second" });
  // Redelivering a waiting event, through the same route, places and writes nothing new.
  await queue.delivered({ eventId: "grace-1", sender: "grace" });
  // The running turn gets each card at its next boundary; only the requests wait.
  expect(queue.requestIds()).toEqual([
    "dispatch first",
    "write route:orders:ada-1 (ada-1)",
    "write route:orders:grace-1 (grace-1)",
    "write route:orders:ada-2 (ada-2)",
  ]);

  // Oldest first: Ada's first event leads the next turn, which takes her other waiting event
  // along; Grace's event and Ada's prompt each need a turn of their own.
  await queue.settle("first");
  await queue.settle("route:orders:ada-1");
  await queue.settle("route:orders:grace-1");
  await queue.settle("second");
  expect(queue.turns()).toEqual([
    "dispatch first",
    "dispatch route:orders:ada-1 (ada-1, ada-2)",
    "dispatch route:orders:grace-1 (grace-1)",
    "dispatch second",
  ]);
  // Each event stands as the turn that handled it does.
  expect(await queue.submission("route:orders:ada-2")).toEqual({
    requestId: "route:orders:ada-2",
    status: "running",
  });

  // An event handled before is not handled again; a workflow's reply has no route.
  await queue.delivered({ eventId: "ada-2" });
  await queue.delivered({ eventId: "run-1", routeId: null });
  expect(queue.turns().slice(4)).toEqual(["dispatch reply:run-1 (run-1)"]);
});

test("an event the running turn's sender caused joins that turn instead of waiting for one", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "first" });
  await queue.delivered({ eventId: "ada-1" });
  await queue.delivered({ eventId: "grace-1", sender: "grace" });
  // Ada's turn sees both cards at its next boundary, but handles only her own event.
  expect(queue.requestIds()).toEqual([
    "dispatch first",
    "steer route:orders:ada-1 (ada-1)",
    "write route:orders:grace-1 (grace-1)",
  ]);
  expect(queue.publishedQueue()).toEqual(["notification route:orders:grace-1"]);
  expect(await queue.submission("route:orders:ada-1")).toEqual({
    requestId: "route:orders:ada-1",
    status: "running",
  });

  await queue.settle("route:orders:ada-1");
  await queue.settle("first");
  expect(queue.turns()).toEqual([
    "dispatch first",
    "steer route:orders:ada-1 (ada-1)",
    "dispatch route:orders:grace-1 (grace-1)",
  ]);

  // A stopped turn takes no more work, even from its own sender.
  await queue.settle("route:orders:grace-1");
  await queue.receipt({ requestId: "second" });
  await queue.control("stop");
  await queue.delivered({ eventId: "ada-2" });
  assert(queue.requestIds().at(-1) === "write route:orders:ada-2 (ada-2)");
});

test("a notification never starts an agent", async () => {
  const queue = await piManagerQueue();
  const refused = await queue.notify({ eventId: "early" });
  assert(refused.type === "error");
  assert(refused.error.code === "AGENT_NOT_STARTED");

  await queue.receipt({ requestId: "first" });
  await queue.settle("first");
  await queue.delivered({ eventId: "early" });
  expect(queue.requestIds()).toEqual(["dispatch first", "dispatch route:orders:early (early)"]);
});

test("a queue the agent cannot be shown fails none of its changes", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "first" });
  queue.failing.publications = 2;
  await queue.receipt({ requestId: "second" });
  await queue.settle("first");
  expect(queue.turns()).toEqual(["dispatch first", "dispatch second"]);
  // The agent shows what it was shown last, until the next change publishes again.
  expect(queue.publishedQueue()).toEqual([]);
  await queue.receipt({ requestId: "third" });
  expect(queue.publishedQueue()).toEqual(["prompt third"]);
});

test("the agent is shown what waits in its queue", async () => {
  const queue = await piManagerQueue();
  await queue.receipt({ requestId: "first" });
  expect(queue.publishedQueue()).toEqual([]);

  await queue.receipt({ requestId: "second" });
  expect(queue.publishedQueue()).toEqual(["prompt second"]);
  await queue.delivered({ eventId: "ada-1", sender: "grace" });
  expect(queue.publishedQueue()).toEqual(["prompt second", "notification route:orders:ada-1"]);
  await queue.settle("first");
  expect(queue.publishedQueue()).toEqual(["notification route:orders:ada-1"]);

  await queue.control("stop");
  expect(queue.publishedQueue()).toEqual(["paused", "notification route:orders:ada-1"]);
  await queue.control("resume");
  expect(queue.publishedQueue()).toEqual(["notification route:orders:ada-1"]);
});
