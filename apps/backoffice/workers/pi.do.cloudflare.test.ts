import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test, assert } from "vitest";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { env } from "cloudflare:workers";

import { createRegistry, Harness, type ConversationView } from "@earendil-works/pi-durable";

import {
  BACKOFFICE_SYSTEM_ACTORS,
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  type BackofficeContextScope,
} from "@/backoffice-runtime/context";
import { createAuthorizedBackofficeObjectRequest } from "@/backoffice-runtime/internal-object-request";
import {
  backofficeObjectScopeFromContextScope,
  encodeBackofficeObjectAddress,
} from "@/backoffice-runtime/object-registry";
import { createCloudflareDurableObjectRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  piAgentConfigSchema,
  piAgentObjectName,
  type PiAgentConfig,
} from "@/fragno/pi-manager/pi-agent-contract";

import { openPiSessionStore } from "./lib/pi-session-store";
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
      return JSON.parse(line) as { type: "snapshot" | "update"; view: ConversationView };
    }
    const result = await reader.read();
    if (result.done) {
      throw new Error("Pi view stream closed before the expected frame.");
    }
    state.buffer += decoder.decode(result.value, { stream: true });
  }
}

async function createSession(organizationId: string, name: string) {
  const response = await managerRequest(organizationId, "/sessions", {
    name,
    model: { provider: "faux", modelId: "faux-1" },
    instructions: "You are a durable test agent.",
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json<PiAgentConfig>();
}

describe("Pi durable agent scenarios", () => {
  test("creates an org directory, hands off a prompt, runs tools, and reconnects after eviction", async () => {
    const organizationId = `pi-org-${crypto.randomUUID()}`;
    const session = await createSession(organizationId, "First agent");
    const other = await createSession(organizationId, "Second agent");
    const firstPageResponse = await managerRequest(organizationId, "/sessions?pageSize=1");
    assert(firstPageResponse.status === 200);
    const firstPage = await firstPageResponse.json<{
      sessions: PiAgentConfig[];
      cursor: string;
      hasNextPage: boolean;
    }>();
    expect(firstPage.sessions).toHaveLength(1);
    assert(firstPage.hasNextPage);
    const secondPage = await (
      await managerRequest(
        organizationId,
        `/sessions?cursor=${encodeURIComponent(firstPage.cursor)}`,
      )
    ).json<{ sessions: PiAgentConfig[]; hasNextPage: boolean }>();
    assert(!secondPage.hasNextPage);
    expect(
      [...firstPage.sessions, ...secondPage.sessions].map((entry) => entry.sessionId).sort(),
    ).toEqual([session.sessionId, other.sessionId].sort());

    const prompt = { requestId: "prompt-1", content: "Please echo and answer." };
    const submitted = await managerRequest(
      organizationId,
      `/sessions/${session.sessionId}/prompts`,
      prompt,
    );
    expect(submitted.status, await submitted.clone().text()).toBe(202);
    const receipt = await submitted.json<{ submissionId: number }>();
    const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(session));
    const waiting = managerRequest(
      organizationId,
      `/sessions/${session.sessionId}/submissions/prompt-1/wait?waitMs=5000`,
    );
    await runDurableObjectAlarm(agent);
    const waited = await waiting;
    expect(waited.status, await waited.clone().text()).toBe(200);
    expect(await waited.json()).toMatchObject({
      status: "settled",
      submission: { id: receipt.submissionId, status: "done" },
    });

    const completed = await (
      await managerRequest(organizationId, `/sessions/${session.sessionId}/submissions/prompt-1`)
    ).json();
    expect(completed).toMatchObject({ id: receipt.submissionId, status: "done" });
    const view = await (
      await managerRequest(organizationId, `/sessions/${session.sessionId}/view`)
    ).json<ConversationView>();
    expect(view.entries.map((entry) => entry.kind)).toContain("pi.tool-result");
    expect(JSON.stringify(view.entries)).toContain("durable tool result");
    expect(JSON.stringify(view.entries)).toContain("durable answer");
    expect(await (await managerRequest(organizationId, "/models")).json()).toEqual([
      { provider: "faux", modelId: "faux-1", label: "Faux 1" },
    ]);
    const history = await (
      await managerRequest(organizationId, `/sessions/${session.sessionId}/entries?pageSize=2`)
    ).json<{ entries: unknown[]; hasNextPage: boolean }>();
    expect(history.entries).toHaveLength(2);
    assert(history.hasNextPage);
    const exported = await managerRequest(organizationId, `/sessions/${session.sessionId}/export`);
    assert(exported.status === 200);
    expect(new TextDecoder().decode(await exported.arrayBuffer())).toContain(
      '"type":"pi-durable-session"',
    );
    await runInDurableObject(agent, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray();
      expect(tables.map((table) => table.name)).toContain("pi_tasks");
    });

    await evictDurableObject(agent);
    await evictDurableObject(manager(organizationId));
    const duplicate = await managerRequest(
      organizationId,
      `/sessions/${session.sessionId}/prompts`,
      prompt,
    );
    expect(await duplicate.json()).toMatchObject(receipt);
    await runDurableObjectAlarm(agent);
    const restored = await (
      await managerRequest(organizationId, `/sessions/${session.sessionId}/view`)
    ).json<ConversationView>();
    expect(restored.entries).toEqual(view.entries);
    const untouched = await (
      await managerRequest(organizationId, `/sessions/${other.sessionId}/view`)
    ).json<ConversationView>();
    expect(untouched.entries).toHaveLength(0);
  });

  test("transfers the Pi conversation NDJSON stream through Cloudflare RPC", async () => {
    const organizationId = `pi-stream-${crypto.randomUUID()}`;
    const session = await createSession(organizationId, "Streaming agent");
    const response = await managerRequest(
      organizationId,
      `/sessions/${session.sessionId}/view-stream`,
    );
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const reader = response.body!.getReader();

    expect(await readPiViewStreamFrame(reader, { buffer: "" })).toMatchObject({
      type: "snapshot",
      view: { entries: [] },
    });
    await reader.cancel();
  });

  test("singleton, user, and project managers preserve scope through handoff and cold restore", async () => {
    const suffix = crypto.randomUUID();
    const scopes: BackofficeContextScope[] = [
      { kind: "system" },
      { kind: "user", userId: suffix },
      { kind: "project", orgId: suffix, projectId: "shared-project" },
      { kind: "project", orgId: `other-${suffix}`, projectId: "shared-project" },
    ];
    const sessions: PiAgentConfig[] = [];
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
      const created = await request("/sessions", {
        name: "Scoped agent",
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "Answer in this scope.",
        billingOrganizationId: scope.kind === "user" ? "billing-org" : null,
      });
      assert.equal(created.status, 201, await created.clone().text());
      const session = await created.json<PiAgentConfig>();
      expect(session.scope).toEqual(scope);
      sessions.push(session);
      const prompt = { requestId: "scoped-prompt", content: "Echo and answer in this scope." };
      const submitted = await request(`/sessions/${session.sessionId}/prompts`, prompt);
      assert.equal(submitted.status, 202, await submitted.clone().text());
      const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(session));
      // Submission schedules a real alarm, which may already be running; wait for the prompt to
      // settle rather than assuming this alarm call performs the turn.
      const waiting = request(
        `/sessions/${session.sessionId}/submissions/${prompt.requestId}/wait?waitMs=5000`,
      );
      await runDurableObjectAlarm(agent);
      const waited = await waiting;
      assert.equal(waited.status, 200, await waited.clone().text());
      expect(await waited.json()).toMatchObject({
        status: "settled",
        submission: { status: "done" },
      });
      const view = await (
        await request(`/sessions/${session.sessionId}/view`)
      ).json<ConversationView>();
      expect(JSON.stringify(view.entries)).toContain("durable answer");
      await evictDurableObject(agent);
      await evictDurableObject(scopedManager);
      const restored = await (
        await request(`/sessions/${session.sessionId}/view`)
      ).json<ConversationView>();
      expect(restored.entries).toEqual(view.entries);
      const directory = await (await request("/sessions")).json<{ sessions: PiAgentConfig[] }>();
      expect(directory.sessions.map((entry) => entry.sessionId)).toContain(session.sessionId);
      for (const foreign of sessions.filter((entry) => entry.sessionId !== session.sessionId)) {
        assert.equal((await request(`/sessions/${foreign.sessionId}/prompts`, prompt)).status, 404);
      }
    }
  });

  test("a cold alarm resumes an unfinished input without admitting it again", async () => {
    const organizationId = `pi-recovery-${crypto.randomUUID()}`;
    const config = await createSession(organizationId, "Recovering agent");
    const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(config));
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
      await state.storage.put("pi-agent-config", piAgentConfigSchema.parse(config));
      const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: config.model } });
      await root.submit(
        { type: "input", content: "Recover this prompt.", requestId: "recovery-1" },
        BACKGROUND_CONTEXT,
      );
      expect((await harness.inspect(BACKGROUND_CONTEXT)).tasks.length).toBeGreaterThan(0);
      await harness.close(BACKGROUND_CONTEXT);
      await state.storage.setAlarm(Date.now() + 86_400_000);
    });
    await evictDurableObject(agent);
    await runDurableObjectAlarm(agent);
    const submission = await (
      await managerRequest(organizationId, `/sessions/${config.sessionId}/submissions/recovery-1`)
    ).json();
    expect(submission).toMatchObject({ status: "done", requestId: "recovery-1" });
    const view = await (
      await managerRequest(organizationId, `/sessions/${config.sessionId}/view`)
    ).json<ConversationView>();
    expect(view.entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    expect(JSON.stringify(view.entries)).toContain("durable answer");
    await runInDurableObject(agent, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  test.each(["view", "alarm"] as const)(
    "a cold startup failure does not prevent a later %s from reopening the session",
    async (retryThrough) => {
      const config: PiAgentConfig = {
        scope: { kind: "org", orgId: `pi-startup-retry-${crypto.randomUUID()}` },
        sessionId: crypto.randomUUID(),
        name: "Recovering startup",
        model: { provider: "faux", modelId: "faux-1" },
        instructions: "Recover after the storage connection fails.",
        actors: BACKOFFICE_SYSTEM_ACTORS,
        billingOrganizationId: null,
        scopeRestriction: null,
      };
      const testEnv = env as CloudflareEnv;
      const stub = testEnv.PI.getByName(piAgentObjectName(config));
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("pi-agent-config", piAgentConfigSchema.parse(config));
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
          options: { models, registry: createRegistry(), onReport: (error) => reports.push(error) },
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
          await expect(object.getView(config)).rejects.toThrow(startupError.message);
          if (retryThrough === "alarm") {
            await object.alarm();
          }
          await expect(object.getView(config)).resolves.toMatchObject({ entries: [] });
          expect(reports).toEqual([startupError]);
          await expect(state.storage.get("pi-agent-config")).resolves.toEqual(config);

          await object.submit(config, {
            requestId: "startup-recovered",
            content: "Finish the recovered session.",
            whenBusy: "followUp",
          });
          expect(await state.storage.getAlarm()).not.toBeNull();
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

  test("rejects unsigned and wrong-scope requests and cannot hand off another org's session", async () => {
    const organizationId = `pi-owner-${crypto.randomUUID()}`;
    const strangerId = `pi-stranger-${crypto.randomUUID()}`;
    const session = await createSession(organizationId, "Owned agent");
    const unsigned = await manager(organizationId).fetch(
      "https://backoffice.example/api/pi-manager/sessions",
    );
    assert(unsigned.status === 401);
    assert((await managerRequest(organizationId, "/sessions", undefined, "agent")).status === 403);
    assert((await managerRequest(organizationId, "/sessions?pageSize=0")).status === 400);
    assert((await managerRequest(organizationId, "/sessions?cursor=invalid")).status === 400);
    const missing = await managerRequest(strangerId, `/sessions/${session.sessionId}/prompts`, {
      requestId: "unauthorized",
      content: "Cannot reach the owned agent.",
    });
    assert(missing.status === 404);
    const foreign = await createAuthorizedBackofficeObjectRequest({
      request: new Request("https://backoffice.example/api/pi-manager/sessions"),
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
    const agent = (env as CloudflareEnv).PI.getByName(piAgentObjectName(session));
    await runInDurableObject(agent, async (instance) => {
      const pi = instance as Pi;
      await expect(
        pi.initialize({ ...session, scope: { kind: "org", orgId: strangerId } }),
      ).rejects.toThrow("object address");
    });
  });
});
