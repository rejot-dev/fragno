import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, assert, vi } from "vitest";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { AutomationActors } from "@fragno-dev/backoffice-api/v0/automation";
import {
  piAgentConfigSchema,
  type PiAgentConfig,
  type PiManagerAgent,
} from "@fragno-dev/backoffice-api/v0/pi";
import { allBackofficePermissionRequirements } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { env } from "cloudflare:workers";

import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  ROOT_CONVERSATION_ID,
  type ConversationView,
} from "@earendil-works/pi-durable";

import { createCloudflareBackofficeObjectRegistry } from "@/backoffice-runtime/cloudflare-durable-object-factory";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
} from "@/backoffice-runtime/context";
import { createAuthorizedBackofficeObjectRequest } from "@/backoffice-runtime/internal-object-request";
import {
  backofficeObjectScopeFromContextScope,
  encodeBackofficeObjectAddress,
} from "@/backoffice-runtime/object-registry";
import { createCloudflareDurableObjectRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  piAgentObjectName,
  type PiAgentTurn,
  piAgentViewSocketRequest,
  type PiAgentViewFrame,
} from "@/fragno/pi/agent/pi-agent-contract";
import { recordPiAgentTurn } from "@/fragno/pi/agent/pi-agent-turns";

import { createScriptedPiAgentDependencies } from "./pi-durable-scenario.test-support";
import { PiObject, openPiAgentStorage } from "./pi-object";
import { type Pi } from "./pi.do";

function manager(organizationId: string) {
  return (env as CloudflareEnv).PI_MANAGER.getByName(
    `v1:org:${encodeURIComponent(organizationId)}`,
  );
}

async function managerRequest(
  organizationId: string,
  path: string,
  body?: unknown,
  service: "automation" | "agent" = "automation",
) {
  const request = new Request(`https://backoffice.example/api/pi-manager${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const authorized = await createAuthorizedBackofficeObjectRequest({
    request,
    address: {
      binding: "PI_MANAGER",
      scope: { kind: "org", orgId: organizationId, jurisdiction: null },
    },
    context: {
      execution: createBackofficeServiceExecution({
        scope: { kind: "org", orgId: organizationId, jurisdiction: null },
        service: { type: service, id: "pi-durable-scenario" },
      }),
      propagationContext: null,
    },
    env: env as CloudflareEnv,
  });
  return await manager(organizationId).fetch(authorized);
}

/** Opens an agent's view socket as the worker does, and collects what it sends. */
async function openViewSocket(
  organizationId: string,
  agentName = "assistant",
  delegation: AutomationActors["delegation"] = [],
) {
  const agent = {
    scope: { kind: "org", orgId: organizationId, jurisdiction: null } as const,
    agentName,
  };
  const execution = createBackofficeServiceExecution({
    scope: agent.scope,
    service: { type: "automation", id: "pi-durable-scenario" },
  });
  const response = await createCloudflareBackofficeObjectRegistry(env as CloudflareEnv)
    .piAgent(agent)
    .fetchAuthorized(piAgentViewSocketRequest(agent), {
      execution: { ...execution, actors: { ...execution.actors, delegation } },
      propagationContext: null,
    });
  const socket = response.webSocket;
  assert(socket, `The agent answered ${response.status} instead of upgrading.`);
  const frames: PiAgentViewFrame[] = [];
  const closes: string[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string) as PiAgentViewFrame);
  });
  socket.addEventListener("close", (event) => {
    closes.push(`${event.code} ${event.reason}`);
  });
  socket.accept();
  return { socket, frames, closes };
}

/** A turn settles before its alarm clears the wake heartbeat, so the clear is observed eventually. */
async function expectAlarmCleared(agent: DurableObjectStub<Pi>) {
  await vi.waitFor(async () => {
    await runInDurableObject(agent, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
}

function orgAgent(organizationId: string): PiAgentConfig {
  return {
    scope: { kind: "org", orgId: organizationId, jurisdiction: null },
    agentName: "assistant",
  };
}

/** Authority for turns seeded below Backoffice's manager, as the manager would record it. */
function seededTurn(config: PiAgentConfig): PiAgentTurn {
  return {
    actors: createBackofficeServiceExecution({
      scope: config.scope,
      service: { type: "automation", id: "pi-durable-scenario" },
    }).actors,
    scopeRestriction: null,
    agent: {
      model: { provider: "faux", modelId: "faux-1", thinkingLevel: "low" },
      instructions: "",
      permissions: [...allBackofficePermissionRequirements],
    },
  };
}
/** Polls, since the agent's own alarm may still be running the turn. */
async function expectSubmissionDone(organizationId: string, requestId: string) {
  await expect
    .poll(
      async () =>
        await (
          await managerRequest(organizationId, `/agents/assistant/prompts/${requestId}`)
        ).json(),
    )
    .toMatchObject({ requestId, status: "completed" });
}

describe("Pi durable agent scenarios", () => {
  test("provisions an org agent with its first turn, runs tools, and reconnects after eviction", async () => {
    const organizationId = `pi-org-${crypto.randomUUID()}`;
    const config = orgAgent(organizationId);
    const before = await (
      await managerRequest(organizationId, "/agents/assistant")
    ).json<PiManagerAgent>();
    assert.equal(before.provisioned, false);

    const prompt = {
      requestId: "prompt-1",
      content: "Please echo and answer.",
    };
    const submitted = await managerRequest(organizationId, "/agents/assistant/prompts", prompt);
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const receipt = await submitted.json<{ requestId: string; status: string }>();
    expect(receipt).toEqual({ requestId: "prompt-1", status: "queued" });
    const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(config));
    await runDurableObjectAlarm(agent);
    await expectSubmissionDone(organizationId, "prompt-1");

    const after = await (
      await managerRequest(organizationId, "/agents/assistant")
    ).json<PiManagerAgent>();
    expect(after.provisioned).toEqual(true);
    const view = await (
      await managerRequest(organizationId, "/agents/assistant/view")
    ).json<ConversationView>();
    expect(view.entries.map((entry) => entry.kind)).toContain("pi.tool-result");
    expect(JSON.stringify(view.entries)).toContain("durable tool result");
    expect(JSON.stringify(view.entries)).toContain("durable answer");
    expect(await (await managerRequest(organizationId, "/models")).json()).toEqual([
      {
        provider: "faux",
        modelId: "faux-1",
        label: "Faux 1",
        contextWindow: 128_000,
        thinkingLevels: ["off"],
      },
    ]);
    const history = await (
      await managerRequest(
        organizationId,
        `/agents/assistant/entries?before=${view.entries.at(-1)?.id}&pageSize=2`,
      )
    ).json<{ entries: unknown[]; hasNextPage: boolean }>();
    expect(history.entries).toHaveLength(2);
    assert(history.hasNextPage);
    const exported = await managerRequest(organizationId, "/agents/assistant/export");
    assert(exported.status === 200);
    expect(new TextDecoder().decode(await exported.arrayBuffer())).toContain(
      '"type":"pi-durable-agent"',
    );
    await expectAlarmCleared(agent);
    await runInDurableObject(agent, async (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray();
      expect(tables.map((table) => table.name)).toContain("pi_tasks");
    });

    await evictDurableObject(agent);
    await evictDurableObject(manager(organizationId));
    const duplicate = await managerRequest(organizationId, "/agents/assistant/prompts", prompt);
    expect(await duplicate.json()).toMatchObject(receipt);
    await runDurableObjectAlarm(agent);
    const restored = await (
      await managerRequest(organizationId, "/agents/assistant/view")
    ).json<ConversationView>();
    expect(restored.entries).toEqual(view.entries);
  });

  test("serves the conversation and its queue over the agent's view socket", async () => {
    const organizationId = `pi-socket-${crypto.randomUUID()}`;
    const agent = {
      scope: { kind: "org", orgId: organizationId, jurisdiction: null } as const,
      agentName: "assistant",
    };
    const unsigned = await (env as CloudflareEnv).PI.getByName(piAgentObjectName(agent)).fetch(
      piAgentViewSocketRequest(agent),
    );
    assert.equal(unsigned.status, 401);
    // Reading the body also releases the response, whose stream would keep the agent from hibernating.
    expect(await unsigned.json()).toMatchObject({ code: "INVALID_INTERNAL_CONTEXT" });
    // The manager refuses before the first turn, and says so for a name no agent has.
    const notStarted = await openViewSocket(organizationId);
    const misspelled = await openViewSocket(organizationId, "assistnt");
    await vi.waitFor(() => {
      expect([...notStarted.closes, ...misspelled.closes]).toEqual([
        "4000 Pi agent has no turns yet.",
        "4000 No agent in this scope is named 'assistnt'.",
      ]);
    });
    // A denial naming a long delegate outgrows a close reason; it is shortened rather than turned
    // into a close the viewer reconnects after.
    const denied = await openViewSocket(organizationId, "assistant", [
      {
        scope: "internal",
        type: "automation",
        id: `automation-route:${"r".repeat(100)}`,
        role: "delegate",
      },
    ]);
    await vi.waitFor(() => {
      expect(denied.closes).toHaveLength(1);
    });
    expect(denied.closes[0]).toMatch(/^4000 Delegated automation 'automation-route:r+…$/);
    expect(
      new TextEncoder().encode(denied.closes[0].slice("4000 ".length)).byteLength,
    ).toBeLessThanOrEqual(123);

    const submitted = await managerRequest(organizationId, "/agents/assistant/prompts", {
      requestId: "socket-1",
      content: "Please echo and answer.",
    });
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const { socket, frames } = await openViewSocket(organizationId);

    // The manager's answer carries the queue, empty since the prompt was dispatched; the view follows.
    await vi.waitFor(() => {
      expect(frames.slice(0, 2)).toMatchObject([
        { type: "queue", paused: false, items: [] },
        { type: "view" },
      ]);
    });
    // Commits arrive as ops on top of that view.
    function viewed() {
      let view: ConversationView | undefined;
      for (const frame of frames) {
        if (frame.type === "view") {
          view = frame.view;
        } else if (frame.type === "ops") {
          view = applyImmutable<ConversationView>(view, frame.ops);
        }
      }
      return view;
    }
    await vi.waitFor(() => {
      expect(JSON.stringify(viewed()?.entries)).toContain("durable answer");
    });
    expect(frames.filter((frame) => frame.type === "view")).toHaveLength(1);
    const piAgent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(agent));
    await expectAlarmCleared(piAgent);

    // The idle agent hibernates with its socket open. Waking it, here to show a stopped queue,
    // sends the whole view again, since reopening the agent may commit what the socket never saw.
    await evictDurableObject(piAgent);
    const stopped = await managerRequest(organizationId, "/agents/assistant/stop", {});
    expect(stopped.status, await stopped.clone().text()).toBe(204);
    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === "view")).toHaveLength(2);
      expect(frames).toContainEqual({ type: "queue", paused: true, items: [] });
    });
    expect(viewed()).toEqual(
      await (await managerRequest(organizationId, "/agents/assistant/view")).json(),
    );
    socket.close();
  });

  test("singleton, user, and project managers preserve scope through handoff and cold restore", async () => {
    const suffix = crypto.randomUUID();
    const scopes: BackofficeContextScope[] = [
      { kind: "system" },
      { kind: "user", userId: suffix, jurisdiction: null },
      {
        kind: "project",
        owner: { kind: "org", orgId: suffix, jurisdiction: null },
        projectId: "shared-project",
      },
      {
        kind: "project",
        owner: { kind: "org", orgId: `other-${suffix}`, jurisdiction: null },
        projectId: "shared-project",
      },
    ];
    for (const scope of scopes) {
      const address = {
        binding: "PI_MANAGER",
        scope: backofficeObjectScopeFromContextScope(scope),
      } as const;
      const scopedManager = (env as CloudflareEnv).PI_MANAGER.getByName(
        encodeBackofficeObjectAddress(address),
      );
      async function request(route: string, body?: unknown) {
        return await scopedManager.fetch(
          await createAuthorizedBackofficeObjectRequest({
            request: new Request(`https://backoffice.example/api/pi-manager${route}`, {
              method: body === undefined ? "GET" : "POST",
              headers: body === undefined ? {} : { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
            address,
            context: {
              execution:
                scope.kind === "system"
                  ? createBackofficeSystemExecution(scope)
                  : createBackofficeServiceExecution({
                      scope,
                      service: { type: "automation", id: "scoped-pi-scenario" },
                    }),
              propagationContext: null,
            },
            env: env as CloudflareEnv,
          }),
        );
      }
      const prompt = {
        requestId: "scoped-prompt",
        content: "Echo and answer in this scope.",
      };
      const submitted = await request("/agents/assistant/prompts", prompt);
      assert.equal(submitted.status, 202, await submitted.clone().text());
      const agent = (env as CloudflareEnv).PI.getByName(
        piAgentObjectName({ scope, agentName: "assistant" }),
      );
      // Submission schedules a real alarm, which may already be running; wait for the prompt to
      // settle rather than assuming this alarm call performs the turn.
      await runDurableObjectAlarm(agent);
      await expect
        .poll(
          async () => await (await request(`/agents/assistant/prompts/${prompt.requestId}`)).json(),
        )
        .toMatchObject({ status: "completed" });
      const view = await (await request("/agents/assistant/view")).json<ConversationView>();
      expect(JSON.stringify(view.entries)).toContain("durable answer");
      expect(view.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
      await evictDurableObject(agent);
      await evictDurableObject(scopedManager);
      const restored = await (await request("/agents/assistant/view")).json<ConversationView>();
      expect(restored.entries).toEqual(view.entries);
      const provisioned = await (await request("/agents/assistant")).json<PiManagerAgent>();
      expect(provisioned.provisioned).not.toBeNull();
    }
  });

  test("a cold alarm resumes an unfinished input without admitting it again", async () => {
    const organizationId = `pi-recovery-${crypto.randomUUID()}`;
    const config = orgAgent(organizationId);
    const directory = await managerRequest(organizationId, "/agents/assistant/prompts", {
      requestId: "provision",
      content: "Provision the agent.",
    });
    expect(directory.status, await directory.clone().text()).toBe(202);
    const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(config));
    await runDurableObjectAlarm(agent);
    await expectAlarmCleared(agent);
    await evictDurableObject(agent);
    await runInDurableObject(agent, async (_instance, state) => {
      // Seed the state left by a prior process using Pi's real admission and close APIs.
      const faux = fauxProvider({ tokensPerSecond: 1 });
      faux.setResponses([fauxAssistantMessage([fauxText("unfinished answer")])]);
      const models = createModels();
      models.setProvider(faux.provider);
      const storage = await openPiAgentStorage(state.storage);
      const harness = await Harness.open(
        storage,
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT);
      await recordPiAgentTurn(
        harness,
        root.id,
        "recovery-1",
        seededTurn(config),
        BACKGROUND_CONTEXT,
      );
      await root.submit(
        { type: "input", content: "Recover this prompt.", requestId: "recovery-1" },
        BACKGROUND_CONTEXT,
      );
      expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks.length).toBeGreaterThan(0);
      await harness.close(BACKGROUND_CONTEXT);
      await state.storage.setAlarm(Date.now() + 86_400_000);
    });
    await evictDurableObject(agent);
    // The woken object schedules its own alarm for now, which may resume the input before this
    // alarm call does; wait for the input to settle either way.
    await runDurableObjectAlarm(agent);
    await expectSubmissionDone(organizationId, "recovery-1");
    const view = await (
      await managerRequest(organizationId, "/agents/assistant/view")
    ).json<ConversationView>();
    // The provisioning prompt and the recovered one, each admitted exactly once.
    expect(view.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(2);
    expect(JSON.stringify(view.entries)).toContain("Recover this prompt.");
    await expectAlarmCleared(agent);
  });

  test.each(["view", "alarm"] as const)(
    "a cold startup failure does not prevent a later %s from reopening the agent",
    async (retryThrough) => {
      const config = orgAgent(`pi-startup-retry-${crypto.randomUUID()}`);
      const testEnv = env as CloudflareEnv;
      const stub = testEnv.PI.getByName(piAgentObjectName(config));
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("pi-agent-config", {
          ...piAgentConfigSchema.parse(config),
          billingOrganizationId: "previous-billing-org",
        });
        const startupError = new Error("PI_STARTUP_STORAGE_TEMPORARILY_UNAVAILABLE");
        const reports: unknown[] = [];
        let storageAttempts = 0;
        const faux = fauxProvider();
        faux.setResponses([fauxAssistantMessage("Recovered after startup.")]);
        const models = createModels();
        models.setProvider(faux.provider);
        const object = new PiObject({
          state,
          runtime: createCloudflareDurableObjectRuntimeServices(testEnv, state),
          dependencies: {
            ...createScriptedPiAgentDependencies(models),
            report: (error) => reports.push(error),
          },
          openStorage: async () => {
            storageAttempts += 1;
            if (storageAttempts === 1) {
              throw startupError;
            }
            return await openPiAgentStorage(state.storage);
          },
          idFromConfig: (input) => testEnv.PI.idFromName(piAgentObjectName(input)),
          nowEpochMs: Date.now,
        });
        try {
          // The constructor's startup reports its failure without poisoning later opens.
          await vi.waitFor(() => {
            expect(reports).toEqual([startupError]);
          });
          if (retryThrough === "alarm") {
            await object.alarm();
          }
          await expect(object.getView(config, null)).resolves.toMatchObject({ entries: [] });
          expect(reports).toEqual([startupError]);
          await expect(state.storage.get("pi-agent-config")).resolves.toEqual(config);
          await expect(state.storage.get("pi-legacy-billing-scope")).resolves.toEqual({
            kind: "org",
            orgId: "previous-billing-org",
            jurisdiction: null,
          });

          await object.dispatch(config, 1, seededTurn(config), {
            type: "prompt",
            requestId: "startup-recovered",
            content: "Finish the recovered turn.",
          });
          // The real object's alarm may already have consumed the one this submission scheduled;
          // running this object's alarm performs the turn either way.
          await object.alarm();
          expect(JSON.stringify(await object.getView(config, null))).toContain(
            "Recovered after startup.",
          );
          await expect(object.getSubmission(config, "startup-recovered")).resolves.toMatchObject({
            record: { status: "done" },
          });
          expect(await state.storage.getAlarm()).toBeNull();
          expect(reports).toEqual([startupError]);
        } finally {
          await object.close();
        }
      });
    },
  );

  test("an alarm resumes a sleep due beside running work, and a failed session ends it at once", async () => {
    const config = orgAgent(`pi-wake-${crypto.randomUUID()}`);
    const testEnv = env as CloudflareEnv;
    const stub = testEnv.PI.getByName(piAgentObjectName(config));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("pi-agent-config", piAgentConfigSchema.parse(config));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let napped = false;
      const complete = {
        status: "terminal",
        outcome: { status: "completed", result: null },
      } as const;
      const aborted = { status: "terminal", outcome: { status: "aborted" } } as const;
      // One task runs until released while the other sleeps briefly beside it.
      const Hold = defineTask<null, { phase: "hold" }, null>({
        name: "scenario.hold",
        version: 1,
        initial: () => ({ phase: "hold" }),
        phases: {
          hold: async (_task, runtime, context) => {
            await held;
            await runtime.commit(() => complete, context);
          },
        },
        abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
      });
      const Nap = defineTask<null, { phase: "nap" } | { phase: "wake" }, null>({
        name: "scenario.nap",
        version: 1,
        initial: () => ({ phase: "nap" }),
        phases: {
          nap: (_task, runtime, context) =>
            runtime.sleepUntil(runtime.now() + 200, { phase: "wake" }, context),
          wake: async (_task, runtime, context) => {
            napped = true;
            await runtime.commit(() => complete, context);
          },
        },
        abort: (_task, runtime, context) => runtime.commit(() => aborted, context),
      });
      const scenario = defineExtension({ name: "scenario.wake", tasks: [Hold, Nap] });
      const registry = createRegistry();
      registry.install(scenario);
      const seeding = await Harness.open(
        await openPiAgentStorage(state.storage),
        { models: createModels(), registry },
        BACKGROUND_CONTEXT,
      );
      await seeding.root(BACKGROUND_CONTEXT);
      await seeding.commit(async (tx) => {
        const options = {
          ownership: { kind: "conversation" },
          conversationId: ROOT_CONVERSATION_ID,
          background: true,
        } as const;
        await tx.createTask(Hold, null, options);
        await tx.createTask(Nap, null, options);
      }, BACKGROUND_CONTEXT);
      await seeding.close(BACKGROUND_CONTEXT);

      const storageError = new Error("PI_SCENARIO_STORAGE_UNAVAILABLE");
      let storageFails = false;
      const object = new PiObject({
        state,
        runtime: createCloudflareDurableObjectRuntimeServices(testEnv, state),
        dependencies: {
          ...createScriptedPiAgentDependencies(createModels()),
          extensions: () => [scenario],
          report: () => {},
        },
        openStorage: async () => {
          const storage = await openPiAgentStorage(state.storage);
          return new Proxy(storage, {
            get(target, property) {
              if (property === "commit" && storageFails) {
                return async () => {
                  throw storageError;
                };
              }
              const value: unknown = target[property as keyof typeof target];
              // Storage methods read the storage's private fields, so they run on it.
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        idFromConfig: (input) => testEnv.PI.idFromName(piAgentObjectName(input)),
        nowEpochMs: Date.now,
      });
      try {
        const alarm = object.alarm();
        // Pi keeps no timer for the sleep, so the waiting alarm resumes it on time.
        await vi.waitFor(() => {
          assert(napped);
        });
        // The held task's next commit fails the session; the alarm fails with it, not after its budget.
        storageFails = true;
        release();
        await expect(alarm).rejects.toBe(storageError);
        // The next call opens the agent again, on storage that works.
        storageFails = false;
        await expect(object.getView(config, null)).resolves.toMatchObject({ entries: [] });
      } finally {
        await object.close();
      }
    });
  });

  test("rejects unsigned and wrong-scope requests and cannot hand off another org's agent", async () => {
    const organizationId = `pi-owner-${crypto.randomUUID()}`;
    const strangerId = `pi-stranger-${crypto.randomUUID()}`;
    const config = orgAgent(organizationId);
    const unsigned = await manager(organizationId).fetch(
      "https://backoffice.example/api/pi-manager/agents",
    );
    assert(unsigned.status === 401);
    assert((await managerRequest(organizationId, "/agents", undefined, "agent")).status === 403);
    assert(
      (await managerRequest(organizationId, "/agents/assistant/entries?before=1&pageSize=0"))
        .status === 400,
    );
    const foreign = await createAuthorizedBackofficeObjectRequest({
      request: new Request("https://backoffice.example/api/pi-manager/agents"),
      address: {
        binding: "PI_MANAGER",
        scope: { kind: "org", orgId: strangerId, jurisdiction: null },
      },
      context: {
        execution: createBackofficeServiceExecution({
          scope: { kind: "org", orgId: strangerId, jurisdiction: null },
          service: { type: "automation", id: "stranger" },
        }),
        propagationContext: null,
      },
      env: env as CloudflareEnv,
    });
    assert((await manager(organizationId).fetch(foreign)).status === 401);
    const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(config));
    await runInDurableObject(agent, async (instance) => {
      const pi = instance as Pi;
      await expect(
        pi.initialize({ ...config, scope: { kind: "org", orgId: strangerId, jurisdiction: null } }),
      ).rejects.toThrow("object address");
    });
  });
});
