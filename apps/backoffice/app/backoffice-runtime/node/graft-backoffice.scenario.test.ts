import { afterAll, beforeAll, expect, test, assert } from "vitest";

import type { NodeRuntimeObjects } from "@fragno-private/backoffice-node-runtime/node-object-runtime";
import {
  createNodeRuntimeScenarioEnvironment,
  defineNodeRuntimeScenario,
  runNodeRuntimeScenario,
} from "@fragno-private/backoffice-node-runtime/node-runtime-scenario";

import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentConfig,
} from "../../fragno/pi-manager/pi-agent-contract";
import { createBackofficeSystemExecution } from "../context";
import type { BackofficeRuntimeServices } from "../runtime-services";
import { defineGraftBackofficeObjects } from "./graft-object-definitions";
import {
  createGraftBackofficeCommands,
  type GraftBackofficeObjectResolver,
} from "./graft-object-registry";
import {
  createGraftBackofficeRuntimeServices,
  type GraftBackofficeConfiguration,
} from "./graft-runtime-services";

let environment: Awaited<ReturnType<typeof createNodeRuntimeScenarioEnvironment>>;
beforeAll(async () => {
  environment = await createNodeRuntimeScenarioEnvironment();
});
afterAll(async () => {
  await environment.cleanup();
});
const configuration: GraftBackofficeConfiguration = {
  env: {
    AUTH_ACCESS_TOKEN_SECRET: "graft-backoffice-scenario-access-token-secret",
    BACKOFFICE_INTERNAL_REQUEST_SECRET: "graft-backoffice-scenario-internal-request-secret",
    DOCS_PUBLIC_BASE_URL: "https://backoffice.example/",
    AUTH_EMAIL_VERIFICATION_ENABLED: "false",
    SIGN_UP_INVITATIONS_ENABLED: "false",
    OPENAI_API_KEY: "scenario-key-no-model-requests",
  },
  bridge: null,
};
const objects = defineGraftBackofficeObjects(
  new URL("../../../build-graft/graft-backoffice-objects.mjs", import.meta.url),
  configuration,
);

type BackofficeScenarioObjects = NodeRuntimeObjects<typeof objects>;

function authRequest(path: string, body: unknown) {
  return new Request(`https://backoffice.example/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://backoffice.example" },
    body: JSON.stringify(body),
  });
}

test("Auth migrations, organization hooks, cross-worker Fragment SQL, and restart recovery share Graft storage", async () => {
  const storage = environment.createStorage();
  let services: BackofficeRuntimeServices;
  let organizationId: string;
  const definition = {
    storage,
    objects,
    initialTimeEpochMs: Date.now() + 5_000,
    objectEviction: { kind: "disabled" } as const,
    server({ objects, nowEpochMs }: { objects: BackofficeScenarioObjects; nowEpochMs(): number }) {
      services = createGraftBackofficeRuntimeServices({
        configuration,
        resolve: (binding, name) =>
          objects[binding].get(name) as unknown as ReturnType<GraftBackofficeObjectResolver>,
        nowEpochMs,
      }).services;
      return { fetch: (request: Request) => services.objects.auth.singleton().http.fetch(request) };
    },
  };
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "register and persist hook intent before shutting down the HTTP runtime",
      steps: ({ server, then }) => [
        server.fetch(
          authRequest("sign-up/email", {
            name: "Graft User",
            email: "graft@example.test",
            password: "password123",
          }),
          async (response) => {
            expect(response.status, await response.clone().text()).toBe(200);
          },
        ),
        then("user creation is durable, but organization processing has not run", async () => {
          const queue = await services.objects.auth.singleton().commands.getDurableHookQueue();
          expect(queue.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ hookName: "onUserCreated", status: "pending" }),
            ]),
          );
          expect(await services.objects.auth.singleton().commands.getAllOrganizations()).toEqual(
            [],
          );
        }),
      ],
    }),
  );
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "cold alarm discovery delivers Auth hooks into a different object worker",
      steps: ({ server, alarms, clock, then }) => [
        // Cold initialization re-arms Auth; later deliveries process the user then organization hook.
        alarms.tick(),
        clock.advanceBy(1_000),
        alarms.tick(),
        alarms.tick(),
        then(
          "the account owns an organization and the organization event was ingested",
          async () => {
            const organizations = await services.objects.auth
              .singleton()
              .commands.getAllOrganizations();
            assert(organizations[0]);
            organizationId = organizations[0].id;
            const queue = await services.objects.auth.singleton().commands.getDurableHookQueue();
            expect(
              queue.items.filter(
                (hook) =>
                  hook.hookName === "onUserCreated" || hook.hookName === "onOrganizationCreated",
              ),
            ).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  hookName: "onUserCreated",
                  status: "completed",
                  error: null,
                }),
                expect.objectContaining({
                  hookName: "onOrganizationCreated",
                  status: "completed",
                  error: null,
                }),
              ]),
            );
            const response = await services.objects.automations
              .singleton()
              .http.fetchAuthorized(
                new Request("https://backoffice.example/api/automations/events"),
                {
                  execution: createBackofficeSystemExecution({ kind: "system" }),
                  propagationContext: null,
                },
              );
            expect(response.status, await response.clone().text()).toBe(200);
            expect(await response.json()).toMatchObject({
              events: expect.arrayContaining([
                expect.objectContaining({ subject: { orgId: organizationId } }),
              ]),
            });
          },
        ),
        server.fetch(
          authRequest("sign-in/email", { email: "graft@example.test", password: "password123" }),
          async (response) => {
            expect(response.status, await response.clone().text()).toBe(200);
          },
        ),
      ],
    }),
  );
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "both Auth and Fragment state recover after all owning workers close",
      steps: ({ then }) => [
        then("the organization and its completed hooks are recovered without replay", async () => {
          expect(await services.objects.auth.singleton().commands.getAllOrganizations()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: organizationId })]),
          );
          const queue = await services.objects.auth.singleton().commands.getDurableHookQueue();
          expect(
            queue.items.filter((hook) => hook.hookName === "onOrganizationCreated"),
          ).toHaveLength(1);
          assert(
            queue.items.find((hook) => hook.hookName === "onOrganizationCreated")?.status ===
              "completed",
          );
        }),
      ],
    }),
  );
});

test("overlapping Auth signups retain every response, session cookie, and durable hook", async () => {
  const storage = environment.createStorage();
  const accounts = Array.from({ length: 12 }, (_, index) => ({
    name: `Concurrent Graft User ${index}`,
    email: `graft-concurrent-${index}@example.test`,
    password: "password123",
  }));
  const sessions: Array<{ email: string; cookie: string }> = [];
  let services: BackofficeRuntimeServices;
  const definition = {
    storage,
    objects,
    initialTimeEpochMs: Date.now() + 5_000,
    objectEviction: { kind: "disabled" } as const,
    server({ objects, nowEpochMs }: { objects: BackofficeScenarioObjects; nowEpochMs(): number }) {
      services = createGraftBackofficeRuntimeServices({
        configuration,
        resolve: (binding, name) =>
          objects[binding].get(name) as unknown as ReturnType<GraftBackofficeObjectResolver>,
        nowEpochMs,
      }).services;
      return { fetch: (request: Request) => services.objects.auth.singleton().http.fetch(request) };
    },
  };
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "concurrent Better Auth handlers share one Graft connection",
      steps: ({ when, then, alarms, clock }) => [
        when(
          "register distinct accounts through overlapping real Auth handlers",
          async ({ server }) => {
            await Promise.all(
              accounts.map(async (account, index) => {
                const request = authRequest("sign-up/email", account);
                // These direct-object requests model separate clients, not a burst from one rate-limit bucket.
                request.headers.set("x-forwarded-for", `192.0.2.${index + 1}`);
                const response = await server.fetch(request);
                expect(response.status, await response.clone().text()).toBe(200);
                const cookie = response.headers
                  .getSetCookie()
                  .map((value) => value.split(";", 1)[0])
                  .join("; ");
                expect(cookie).toContain("session_token=");
                sessions.push({ email: account.email, cookie });
              }),
            );
          },
        ),
        then("every committed signup returned a usable session", async ({ server }) => {
          expect(sessions).toHaveLength(accounts.length);
          await Promise.all(
            sessions.map(async ({ email, cookie }) => {
              const response = await server.fetch(
                new Request("https://backoffice.example/api/auth/get-session", {
                  headers: { cookie },
                }),
              );
              expect(response.status, await response.clone().text()).toBe(200);
              expect(await response.json()).toMatchObject({
                user: { email },
                session: { userId: expect.any(String) },
              });
            }),
          );
          const queue = await services.objects.auth.singleton().commands.getDurableHookQueue();
          expect(queue.items.filter((hook) => hook.hookName === "onUserCreated")).toHaveLength(
            accounts.length,
          );
        }),
        alarms.tick(),
        clock.advanceBy(1_000),
        alarms.tick(),
        alarms.tick(),
        then("every account's organization hook is deliverable", async () => {
          expect(
            await services.objects.auth.singleton().commands.getAllOrganizations(),
          ).toHaveLength(accounts.length);
          const queue = await services.objects.auth.singleton().commands.getDurableHookQueue();
          const created = queue.items.filter((hook) => hook.hookName === "onUserCreated");
          expect(created).toHaveLength(accounts.length);
          assert(created.every((hook) => hook.status === "completed" && hook.error === null));
        }),
      ],
    }),
  );
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "concurrent signup sessions survive worker shutdown and restart",
      steps: ({ then }) => [
        then("all cookies still resolve their original durable users", async ({ server }) => {
          await Promise.all(
            sessions.map(async ({ email, cookie }) => {
              const response = await server.fetch(
                new Request("https://backoffice.example/api/auth/get-session", {
                  headers: { cookie },
                }),
              );
              expect(await response.json()).toMatchObject({
                user: { email },
                session: { userId: expect.any(String) },
              });
            }),
          );
        }),
      ],
    }),
  );
});

test("Pi migrations and conversation provisioning survive worker eviction and application cleanup", async () => {
  const storage = environment.createStorage();
  const config: PiAgentConfig = {
    name: "Graft Pi",
    sessionId: "graft-pi-session",
    scope: { kind: "system" },
    model: { provider: "openai", modelId: "gpt-6-luna" },
    instructions: "",
    billingOrganizationId: null,
    actors: createBackofficeSystemExecution({ kind: "system" }).actors,
  };
  let agent: PiAgent;
  let originalView: unknown;
  const definition = {
    storage,
    objects,
    initialTimeEpochMs: Date.now(),
    objectEviction: { kind: "manual", idleTimeoutMs: 1 } as const,
    server({ objects }: { objects: BackofficeScenarioObjects; nowEpochMs(): number }) {
      agent = createGraftBackofficeCommands(
        (binding, name) =>
          objects[binding].get(name) as unknown as ReturnType<GraftBackofficeObjectResolver>,
        "PI",
        piAgentObjectName(config),
      ) as PiAgent;
      return { fetch: async () => new Response("unused") };
    },
  };
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "provision Pi on its worker-managed SQL connection",
      steps: ({ when, then, clock, activations }) => [
        when("provision a real Pi conversation without a model request", async () => {
          originalView = await agent.getView(config);
        }),
        clock.advanceBy(10),
        activations.sweepIdle(),
        then(
          "eviction closes the harness and the new worker recovers the same conversation",
          async () => {
            expect(await agent.getView(config)).toEqual(originalView);
            expect(await agent.listEntries(config, { pageSize: 10, cursor: null })).toMatchObject({
              entries: [],
              cursor: null,
            });
          },
        ),
      ],
    }),
  );
  await runNodeRuntimeScenario(
    defineNodeRuntimeScenario({
      ...definition,
      name: "recover Pi after process shutdown cleanup",
      steps: ({ then }) => [
        then("Pi opens the existing schema rather than a separate local file", async () => {
          expect(await agent.getView(config)).toEqual(originalView);
        }),
      ],
    }),
  );
});
