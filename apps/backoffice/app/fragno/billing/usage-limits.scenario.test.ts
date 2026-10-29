import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { createBackofficeRequestExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import {
  behindBackofficeLayout,
  sessionUserId,
  withBackofficeAccessToken,
} from "@/layouts/backoffice-layout.test-support";
import { compactPiManagerAgent, submitPiManagerPrompt } from "@/routes/backoffice/agents/data";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { createScriptedPiAgentDependencies } from "../../../workers/pi-durable-scenario.test-support";
import { PiObject } from "../../../workers/pi-object";

const scope = { kind: "org", orgId: "org-1", jurisdiction: null } as const;
const clairic = "@cf/cloudflare/clairic";

const runClairic = `async () => await integrations.execute({
  connectionId: "backoffice#workers-ai",
  actionId: ${JSON.stringify(clairic)},
  input: { model: "clairic", state: "Total due: $1,080.00.", fields: { total: { type: "number" } } },
})`;

/** The signed-in administrator's own terminal. */
async function administratorTerminal(ctx: BackofficeScenarioContext) {
  const execution = createBackofficeRequestExecution({
    scope: { kind: "system" },
    verifiedRequestAuthority: {
      userId: "admin-1",
      personalScope: { kind: "user", userId: "admin-1", jurisdiction: null },
      role: "admin",
      organization: null,
      administeredMember: null,
      expiresAt: new Date(Date.now() + 60_000),
      scopeRestriction: null,
    },
  });
  return (
    await createInteractiveBashHost({
      context: createCodemodeRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
        execution,
      }),
    })
  ).bash;
}

/** Runs `act` as a page request of the person whose session `cookie` carries. */
async function asPerson<T>(
  ctx: BackofficeScenarioContext,
  cookie: string,
  act: (
    request: Request,
    context: ReturnType<typeof createBackofficeRouterContextProvider>,
  ) => Promise<T>,
) {
  const request = new Request("https://backoffice.example/backoffice/agents", {
    method: "POST",
    headers: { cookie },
  });
  const context = createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return await behindBackofficeLayout(() => act(request, context))({
    request,
    context,
    params: {},
  });
}

/** Sends a message from the composer of a person's own assistant. */
async function sendPersonalMessage(
  ctx: BackofficeScenarioContext,
  cookie: string,
  userId: string,
  requestId: string,
) {
  return await asPerson(ctx, cookie, (request, context) =>
    submitPiManagerPrompt(request, context, personalScope(userId), "assistant", {
      requestId,
      content: "Plan my week.",
      whenBusy: "followUp",
      whenPaused: "resume",
      model: null,
    }),
  );
}

function personalScope(userId: string) {
  return { kind: "user", userId, jurisdiction: null } as const;
}

async function setLimit(ctx: BackofficeScenarioContext, args: string) {
  const result = await (await administratorTerminal(ctx)).exec(`admin.usage-limits.set ${args}`);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}

test("an organization out of allowance cannot start model work until an administrator raises it", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "monthly usage limits",
      objects: {
        ...allLocalObjects,
        PI: ({ state, runtime, openPiSessionStore, piAgentIdFromConfig, nowEpochMs }) => {
          const faux = fauxProvider();
          faux.setResponses([fauxAssistantMessage("Here is your week.")]);
          const models = createModels();
          models.setProvider(faux.provider);
          return new PiObject({
            state,
            runtime,
            dependencies: createScriptedPiAgentDependencies(models),
            openStorage: openPiSessionStore,
            idFromConfig: piAgentIdFromConfig,
            nowEpochMs,
          });
        },
      },
      piAvailableModels: [
        {
          provider: "faux",
          modelId: "faux-1",
          label: "Faux 1",
          contextWindow: 128_000,
          thinkingLevels: ["off"],
        },
      ],
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false", SIGN_UP_ACCESS_CODES_REQUIRED: "false" },
      vars: () => ({ grace: "", graceId: "" }),
      fakes: ({ fake }) => ({
        workersAi: fake.workersAi({
          models: {
            [clairic]: {
              schemas: {
                input: {
                  type: "object",
                  properties: {
                    model: { type: "string" },
                    fields: {
                      type: "object",
                      additionalProperties: {
                        type: "object",
                        properties: { type: { type: "string", enum: ["number"] } },
                      },
                    },
                  },
                },
                output: { type: "object", properties: { answers: { type: "object" } } },
              },
              run: () => ({
                output: {
                  model: "clairic",
                  answers: {
                    total: { type: "number", value: 1080, guess: 1080, p_null: 0, confidence: 1 },
                  },
                  truncated: false,
                  usage: { input_tokens: 12, output_tokens: 0 },
                },
                neurons: 1.17,
              }),
            },
          },
        }),
      }),
      setup: ({ given }) => [
        given.organization.exists({ id: scope.orgId, slug: "ada-labs", name: "Ada Labs" }),
        given.auth.user({ id: "admin-1", role: "admin" }),
      ],
      steps: ({ when, then }) => [
        then.assert(
          "an administrator limits the organization to a hundredth of a cent",
          async (ctx) => {
            expect(
              await setLimit(ctx, "--org ada-labs --meter ai.cost.total --limit 0.00001"),
            ).toContain("ai.cost.total: $0.00 used of $0.00001 (custom)");
          },
        ),
        // 1.17 neurons at $0.011 per thousand cost $0.00001287.
        then.assert("work below the limit runs, and may carry usage past it", async (ctx) => {
          await ctx.runCodemode({ scope, code: runClairic });
          await ctx.drain();
          expect(ctx.fakes.workersAi?.runs).toHaveLength(1);
        }),
        then.assert("once the limit is used up, a run never reaches Cloudflare", async (ctx) => {
          await expect(ctx.runCodemode({ scope, code: runClairic })).rejects.toThrow(
            "USAGE_LIMIT_EXCEEDED: This organization has used $0.000013 of its $0.00001 monthly ai.cost.total limit.",
          );
          expect(ctx.fakes.workersAi?.runs).toHaveLength(1);
        }),
        then.assert("monitoring hears once that the organization reached its limit", (ctx) => {
          expect(ctx.telemetry.filter((signal) => signal.kind === "usage-limit-reached")).toEqual([
            expect.objectContaining({
              object: { host: "Billing", scope },
              period: expect.stringMatching(/^\d{4}-\d{2}$/u),
              status: expect.objectContaining({
                meter: "ai.cost.total",
                setting: "custom",
                limit: { kind: "limited", quantity: "10000" },
                used: "12870",
              }),
            }),
          ]);
        }),
        then.assert("agent prompts are refused before they queue", async (ctx) => {
          await expect(
            ctx.runCodemode({
              scope,
              code: `async () => await pi.submitPrompt({ agentName: "assistant", content: "Summarize the invoice." })`,
            }),
          ).rejects.toThrow("monthly ai.cost.total limit");
        }),
        then.assert("restoring the default lets the organization work again", async (ctx) => {
          expect(
            await setLimit(ctx, "--org ada-labs --meter ai.cost.total --limit default"),
          ).toContain("ai.cost.total: $0.000013 used of $10.00 (default)");
          await ctx.runCodemode({ scope, code: runClairic });
          expect(ctx.fakes.workersAi?.runs).toHaveLength(2);
        }),
        when.auth.signUp({ email: "grace@example.test", captureSessionCookieAs: "grace" }),
        then.assert("a personal account has a limit of its own", async (ctx) => {
          ctx.vars.graceId = await sessionUserId(ctx, ctx.vars.grace);
          ctx.vars.grace = await withBackofficeAccessToken(ctx, ctx.vars.grace, null);
          expect(
            await sendPersonalMessage(ctx, ctx.vars.grace, ctx.vars.graceId, "plan-week"),
          ).toMatchObject({ receipt: { requestId: "plan-week" }, error: null });
          await setLimit(ctx, `--user ${ctx.vars.graceId} --meter ai.cost.total --limit 0`);
          expect(
            await sendPersonalMessage(ctx, ctx.vars.grace, ctx.vars.graceId, "plan-month"),
          ).toEqual({
            receipt: null,
            error: expect.stringMatching(
              /^This personal account has used \$[\d.]+ of its \$0\.00 monthly ai\.cost\.total limit\./u,
            ),
          });
        }),
        then.assert(
          "a message sent before the limit was reached still gets its receipt",
          async (ctx) => {
            // A lost response is recovered by sending the same request ID again.
            expect(
              await sendPersonalMessage(ctx, ctx.vars.grace, ctx.vars.graceId, "plan-week"),
            ).toMatchObject({ receipt: { requestId: "plan-week" }, error: null });
          },
        ),
        then.assert(
          "compacting the conversation is new model work, and is refused",
          async (ctx) => {
            expect(
              await asPerson(ctx, ctx.vars.grace, (request, context) =>
                compactPiManagerAgent(
                  request,
                  context,
                  personalScope(ctx.vars.graceId),
                  "assistant",
                  null,
                ),
              ),
            ).toEqual({
              taskId: null,
              error: expect.stringContaining("monthly ai.cost.total limit"),
            });
          },
        ),
        then.assert("an administrator lowering a limit below usage is not reaching it", (ctx) => {
          expect(
            ctx.telemetry.filter((signal) => signal.kind === "usage-limit-reached"),
          ).toHaveLength(1);
        }),
      ],
    }),
  );
});
