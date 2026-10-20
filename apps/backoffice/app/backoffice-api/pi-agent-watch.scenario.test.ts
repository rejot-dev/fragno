import { assert, expect, test, vi } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBackofficeApiClient } from "@fragno-dev/backoffice-api/v0/client";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";

import { createScriptedPiAgentDependencies } from "../../workers/pi-durable-scenario.test-support";
import { InMemoryPiObject } from "../../workers/pi.do";
import { backofficeApiRouter } from "./backoffice-api-router";

const origin = "https://backoffice.example";
const answer = "The watched answer arrives frame by frame.";

type Vars = { ownerCookie: string; orgId: string; credential: string };
type Ctx = BackofficeScenarioContext<Vars>;

/** An integrator's client, reaching Backoffice through the API router. */
function apiClient(ctx: Ctx) {
  return createBackofficeApiClient({
    origin,
    accessToken: ctx.vars.credential,
    fetch: async (input, init) =>
      await backofficeApiRouter.fetch(new Request(input, init), {
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
      }),
  });
}

/** The browser's session exchange issues the same user credential the CLI exchange does. */
async function userCredential(ctx: Ctx) {
  const issued = await ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth/backoffice-token`, {
      method: "POST",
      headers: { origin, cookie: ctx.vars.ownerCookie, "content-type": "application/json" },
      body: JSON.stringify({ selection: "required", organizationId: ctx.vars.orgId }),
    }),
  );
  assert(issued.ok, await issued.clone().text());
  const credential = /fragno-backoffice\.access_token=([^;]+)/u.exec(
    issued.headers.get("set-cookie") ?? "",
  )?.[1];
  assert(credential);
  return credential;
}

test("an integrator watches an agent answer live through the API", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backoffice-api-watch-"));
  try {
    await runBackofficeScenario(
      defineBackofficeScenario<Vars>({
        name: "watch a Pi agent through the Backoffice API",
        piAvailableModels: [
          { provider: "faux", modelId: "faux-1", label: "Faux 1", contextWindow: 128_000 },
        ],
        options: { sqliteDataDirectory: directory, drain: false },
        env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
        objects: {
          ...allLocalObjects,
          PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
            const faux = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
            faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
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
        vars: () => ({ ownerCookie: "", orgId: "", credential: "" }),
        steps: ({ when, then }) => [
          when.auth.signUp({ email: "owner@acme.test", captureSessionCookieAs: "ownerCookie" }),
          then.assert("the owner holds a user credential for their organization", async (ctx) => {
            const [organization] = await ctx.runtime.objects.auth
              .singleton()
              .commands.getAllOrganizations();
            assert(organization);
            ctx.vars.orgId = organization.id;
            ctx.vars.credential = await userCredential(ctx);
          }),
          then.assert("an agent that never had a turn cannot be watched", async (ctx) => {
            const scope = { kind: "org", orgId: ctx.vars.orgId } as const;
            const frames = apiClient(ctx).watch(scope, "pi.agent.watch", {
              agentName: "assistant",
            });
            await expect(frames[Symbol.asyncIterator]().next()).rejects.toMatchObject({
              status: 404,
              code: "not_found",
            });
          }),
          then.assert("the watcher sees the answer the agent commits", async (ctx) => {
            const scope = { kind: "org", orgId: ctx.vars.orgId } as const;
            const client = apiClient(ctx);
            await client.call(scope, "pi.prompt.submit", {
              agentName: "assistant",
              content: "Answer while I watch.",
            });

            const draining = ctx.runtime.drain();
            const seen: string[] = [];
            for await (const frame of client.watch(scope, "pi.agent.watch", {
              agentName: "assistant",
            })) {
              seen.push(frame.type);
              if (frame.type !== "queue" && JSON.stringify(frame.view).includes(answer)) {
                break;
              }
            }
            await draining;

            // A watcher starts from a snapshot and follows the agent's commits until it leaves.
            expect(seen.slice(0, 2).sort()).toEqual(["queue", "snapshot"]);
            assert(seen.at(-1) === "update");
          }),
        ],
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
