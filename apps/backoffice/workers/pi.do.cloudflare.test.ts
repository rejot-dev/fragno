import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, assert, vi } from "vitest";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
  piAgentConfigSchema,
  type PiAgentConfig,
  type PiManagerAgent,
} from "@fragno-dev/backoffice-api/v0/pi";
import { allBackofficePermissionRequirements } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { env } from "cloudflare:workers";

import { createRegistry, Harness, type ConversationView } from "@earendil-works/pi-durable";

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
  type PiAgentViewStreamFrame,
} from "@/fragno/pi/agent/pi-agent-contract";
import { recordPiAgentTurn } from "@/fragno/pi/agent/pi-agent-turns";

import { openPiSessionStore } from "./lib/pi-session-store";
import { createScriptedPiAgentDependencies } from "./pi-durable-scenario.test-support";
import { InMemoryPiObject, type Pi } from "./pi.do";

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
    address: { binding: "PI_MANAGER", scope: { kind: "org", orgId: organizationId } },
    context: {
      execution: createBackofficeServiceExecution({
        scope: { kind: "org", orgId: organizationId },
        service: { type: service, id: "pi-durable-scenario" },
      }),
      propagationContext: null,
    },
    env: env as CloudflareEnv,
  });
  return await manager(organizationId).fetch(authorized);
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
      return JSON.parse(line) as PiAgentViewStreamFrame;
    }
    const result = await reader.read();
    if (result.done) {
      throw new Error("Pi view stream closed before the expected frame.");
    }
    state.buffer += decoder.decode(result.value, { stream: true });
  }
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
    scope: { kind: "org", orgId: organizationId },
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
    const waiting = managerRequest(
      organizationId,
      "/agents/assistant/submissions/prompt-1/wait?waitMs=5000",
    );
    await runDurableObjectAlarm(agent);
    const waited = await waiting;
    expect(waited.status, await waited.clone().text()).toBe(200);
    expect(await waited.json()).toMatchObject({
      status: "settled",
      submission: { requestId: "prompt-1", status: "done" },
    });

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

  test("transfers the Pi conversation NDJSON stream through Cloudflare RPC", async () => {
    const organizationId = `pi-stream-${crypto.randomUUID()}`;
    const submitted = await managerRequest(organizationId, "/agents/assistant/prompts", {
      requestId: "stream-1",
      content: "Start the conversation.",
    });
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const response = await managerRequest(organizationId, "/agents/assistant/view-stream");
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const reader = response.body!.getReader();
    const streamState = { buffer: "" };

    // The manager leads with the agent's queue, empty since the prompt was dispatched.
    expect(await readPiViewStreamFrame(reader, streamState)).toEqual({
      type: "queue",
      paused: false,
      items: [],
    });
    expect(await readPiViewStreamFrame(reader, streamState)).toMatchObject({
      type: "snapshot",
    });
    await reader.cancel();
  });

  test("singleton, user, and project managers preserve scope through handoff and cold restore", async () => {
    const suffix = crypto.randomUUID();
    const scopes: BackofficeContextScope[] = [
      { kind: "system" },
      { kind: "user", userId: suffix },
      { kind: "project", owner: { kind: "org", orgId: suffix }, projectId: "shared-project" },
      {
        kind: "project",
        owner: { kind: "org", orgId: `other-${suffix}` },
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
      const waiting = request(`/agents/assistant/submissions/${prompt.requestId}/wait?waitMs=5000`);
      await runDurableObjectAlarm(agent);
      const waited = await waiting;
      assert.equal(waited.status, 200, await waited.clone().text());
      expect(await waited.json()).toMatchObject({
        status: "settled",
        submission: { status: "done" },
      });
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
      const storage = await openPiSessionStore(state.storage);
      const harness = await Harness.open(
        storage,
        { models, registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
      const root = await harness.root(BACKGROUND_CONTEXT);
      await recordPiAgentTurn(harness, "recovery-1", seededTurn(config), BACKGROUND_CONTEXT);
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
    const waiting = managerRequest(
      organizationId,
      "/agents/assistant/submissions/recovery-1/wait?waitMs=5000",
    );
    await runDurableObjectAlarm(agent);
    const waited = await waiting;
    expect(waited.status, await waited.clone().text()).toBe(200);
    expect(await waited.json()).toMatchObject({
      status: "settled",
      submission: { status: "done", requestId: "recovery-1" },
    });
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
        const object = new InMemoryPiObject({
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
            return await openPiSessionStore(state.storage);
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
          await expect(object.getView(config)).resolves.toMatchObject({ entries: [] });
          expect(reports).toEqual([startupError]);
          await expect(state.storage.get("pi-agent-config")).resolves.toEqual(config);
          await expect(state.storage.get("pi-legacy-billing-scope")).resolves.toEqual({
            kind: "org",
            orgId: "previous-billing-org",
          });

          await object.dispatch(config, seededTurn(config), {
            type: "prompt",
            requestId: "startup-recovered",
            content: "Finish the recovered turn.",
          });
          // The real object's alarm may already have consumed the one this submission scheduled;
          // running this object's alarm performs the turn either way.
          await object.alarm();
          expect(JSON.stringify(await object.getView(config))).toContain(
            "Recovered after startup.",
          );
          await expect(object.getSubmission(config, "startup-recovered")).resolves.toMatchObject({
            status: "done",
          });
          expect(await state.storage.getAlarm()).toBeNull();
          expect(reports).toEqual([startupError]);
        } finally {
          await object.close();
        }
      });
    },
  );

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
      address: { binding: "PI_MANAGER", scope: { kind: "org", orgId: strangerId } },
      context: {
        execution: createBackofficeServiceExecution({
          scope: { kind: "org", orgId: strangerId },
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
        pi.initialize({ ...config, scope: { kind: "org", orgId: strangerId } }),
      ).rejects.toThrow("object address");
    });
  });
});
