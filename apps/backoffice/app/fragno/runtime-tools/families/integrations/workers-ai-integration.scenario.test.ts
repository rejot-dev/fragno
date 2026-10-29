import { assert, expect, test, vi } from "vitest";

import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { executeBackofficeRuntimeTool } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";

import { integrationsToolFamily } from "./integration-tools";
import { clairicInputSchema, clairicOutputSchema } from "./workers-ai-clairic";
import { createWorkersAiIntegration } from "./workers-ai-integration";

const scope: BackofficeContextScope = { kind: "org", orgId: "org-1", jurisdiction: null };
const period = new Date().toISOString().slice(0, 7);
const connectionId = "backoffice#workers-ai";
const clairic = "@cf/cloudflare/clairic";

/** An abridged copy of the schemas Cloudflare publishes for Clairic, listing these field specs. */
function cloudflareClairicSchemas({ types, options }: { types: string[]; options: string[] }) {
  return {
    input: {
      type: "object",
      properties: {
        model: { type: "string" },
        fields: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", enum: types },
              ...Object.fromEntries(options.map((option) => [option, {}])),
            },
          },
        },
      },
    },
    output: { type: "object", properties: { answers: { type: "object" } } },
  };
}

const currentSchemas = cloudflareClairicSchemas({
  types: ["text", "number", "date", "time", "datetime", "duration", "list", "estimate", "forecast"],
  options: ["instructions", "unit", "decimals", "items", "min", "max", "null_threshold"],
});

const invoiceInput = {
  model: "clairic",
  state: "Invoice INV-2291 from Acme Supplies. Total due: $1,080.00, net 30.",
  fields: {
    total: { type: "number", instructions: "The amount due" },
    days_to_pay: { type: "estimate", min: 0, max: 120 },
  },
};

const clairicAnswer = {
  model: "clairic",
  answers: {
    total: { type: "number", value: 1080, guess: 1080, p_null: 0.002, confidence: 0.99 },
    days_to_pay: {
      type: "estimate",
      value: 30,
      mean: 30.2,
      median: 31,
      p10: 23,
      p90: 36,
      p_below: 0.000002,
      p_above: 0.000005,
    },
  },
  truncated: false,
  usage: { input_tokens: 129, output_tokens: 0 },
};

/** Runs `integrations.execute` as an agent the system scope delegates only `grants` to. */
async function executeAsDelegate(
  ctx: BackofficeScenarioContext,
  grants: BackofficePermissionRequirement[],
  input: Record<string, unknown>,
) {
  const actor = {
    scope: "internal",
    type: "agent",
    id: "invoice-reader",
    role: "assistant",
  } as const;
  const system = createBackofficeSystemExecution(scope);
  const kernel = new BackofficeKernel({
    ...ctx.runtime.services,
    authorityResolver: withBackofficeActorCapabilityGrants({
      resolver: ctx.runtime.services.authorityResolver,
      actor,
      grants,
    }),
  });
  const execute = integrationsToolFamily.tools.find((tool) => tool.name === "execute");
  assert(execute);
  return await executeBackofficeRuntimeTool(
    execute,
    { connectionId, actionId: clairic, input, unchecked: false },
    createBackofficeToolContext(
      createRouteBackedRuntimeContext({
        runtime: ctx.runtime.services,
        execution: { ...system, actors: { ...system.actors, delegation: [actor] } },
        kernel,
        emitter: { kind: "caller" },
      }),
    ),
  );
}

test("an agent reads an invoice with Clairic, and the organization pays for the neurons", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Clairic through the Workers AI integration",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        workersAi: fake.workersAi({
          models: {
            [clairic]: {
              schemas: currentSchemas,
              // Clairic answers with properties its contract does not name.
              run: () => ({
                output: {
                  ...clairicAnswer,
                  answers: {
                    ...clairicAnswer.answers,
                    total: { ...clairicAnswer.answers.total, debug: "dropped" },
                  },
                },
                neurons: 1.17,
              }),
            },
          },
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert(
          "the platform connection offers Clairic with Backoffice's typed contract and runs it",
          async (ctx) => {
            const run = await ctx.runCodemode({
              scope,
              code: `async () => {
                const target = { connectionId: ${JSON.stringify(connectionId)} };
                const service = (await integrations.discover()).find((s) => s.id === "workers-ai");
                const actions = await integrations.actions(target);
                const verified = await integrations.verify(target);
                const answer = await integrations.execute({
                  ...target,
                  actionId: ${JSON.stringify(clairic)},
                  input: ${JSON.stringify(invoiceInput)},
                });
                return { availability: service.availability, actions, checks: verified.checks, answer };
              }`,
              assertToolCalls: [
                "integrations.discover",
                "integrations.actions",
                "integrations.verify",
                "integrations.execute",
              ],
            });
            expect(run.result).toMatchObject({
              availability: { status: "available" },
              actions: [
                {
                  id: clairic,
                  validation: { kind: "checked" },
                  inputSchema: z.toJSONSchema(clairicInputSchema, { io: "input" }),
                  outputSchema: z.toJSONSchema(clairicOutputSchema, { io: "output" }),
                },
              ],
              checks: [{ id: "models.contract", status: "passed" }],
            });
            expect(run.result).toMatchObject({ answer: clairicAnswer });
            expect(JSON.stringify(run.result)).not.toContain("dropped");
            expect(ctx.fakes.workersAi?.runs).toEqual([{ model: clairic, input: invoiceInput }]);
          },
        ),
        // 1.17 neurons at $0.011 per thousand.
        then.billing.tracker({
          scope,
          period,
          meter: "ai.neurons",
          quantity: "1170",
          eventCount: "1",
        }),
        then.billing.tracker({ scope, period, meter: "ai.cost.total", quantity: "12870" }),
        then.billing.tracker({ scope, period, meter: "workers-ai.runs", quantity: "1" }),
      ],
    }),
  );
});

test("Clairic runs only for callers who may pay, on valid input, with usage it can bill", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Workers AI refusals",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        workersAi: fake.workersAi({
          // Cloudflare has moved past Backoffice's contract, and answers without saying what the
          // run cost.
          models: {
            [clairic]: {
              schemas: cloudflareClairicSchemas({
                types: ["text", "number", "currency"],
                options: ["instructions", "locale"],
              }),
              run: () => ({ output: clairicAnswer, neurons: null }),
            },
          },
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert("verify reports what Clairic accepts that the contract lacks", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => (await integrations.verify({ connectionId: ${JSON.stringify(connectionId)} })).checks`,
          });
          expect(run.result).toMatchObject([
            {
              id: "models.contract",
              status: "failed",
              message: `${clairic}: Clairic accepts field types Backoffice lacks: currency. ${clairic}: Clairic accepts field options Backoffice lacks: locale.`,
            },
          ]);
        }),
        then.assert("a delegate without models.run cannot spend on models", async (ctx) => {
          await expect(
            executeAsDelegate(ctx, [BACKOFFICE_PERMISSION.integrations.execute], invoiceInput),
          ).rejects.toThrow("models.run");
          expect(ctx.fakes.workersAi?.runs).toEqual([]);
        }),
        then.assert("input that breaks Clairic's schema never reaches Cloudflare", async (ctx) => {
          await expect(
            executeAsDelegate(
              ctx,
              [BACKOFFICE_PERMISSION.integrations.execute, BACKOFFICE_PERMISSION.models.run],
              { ...invoiceInput, fields: { total: { type: "currency" } } },
            ),
          ).rejects.toThrow("fields.total.type");
          expect(ctx.fakes.workersAi?.runs).toEqual([]);
        }),
        then.assert("a run that reports no neurons fails and bills nothing", async (ctx) => {
          await expect(
            executeAsDelegate(
              ctx,
              [BACKOFFICE_PERMISSION.integrations.execute, BACKOFFICE_PERMISSION.models.run],
              invoiceInput,
            ),
          ).rejects.toThrow("WORKERS_AI_FAILED: Workers AI reported no neuron usage for the run.");
          expect(ctx.fakes.workersAi?.runs).toHaveLength(1);
          await ctx.runtime.drain();
          const { trackers } = await ctx.runtime.objects.billing
            .for(scope)
            .commands.getTrackers({ scope, period, pageSize: 100 });
          // The codemode run that verified the contract records its own usage.
          expect(
            trackers.filter(
              ({ meter }) => meter.startsWith("ai.") || meter.startsWith("workers-ai."),
            ),
          ).toEqual([]);
        }),
      ],
    }),
  );
});

test("an app workspace, which has no PiManager, reports Workers AI unavailable", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Workers AI outside PiManager's scopes",
      objects: allLocalObjects,
      fakes: ({ fake }) => ({
        workersAi: fake.workersAi({
          models: {
            [clairic]: {
              schemas: currentSchemas,
              run: () => ({ output: clairicAnswer, neurons: 1.17 }),
            },
          },
        }),
      }),
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "Ada Labs" })],
      steps: ({ then }) => [
        then.assert(
          "discovery, listing, and inspection agree, and nothing reaches PiManager",
          async (ctx) => {
            const workspace = { kind: "app", owner: scope, appId: "bookkeeping" } as const;
            const integration = createWorkersAiIntegration({
              runtime: ctx.runtime.services,
              nowEpochMs: Date.now,
            });
            const context = {
              kernel: new BackofficeKernel(ctx.runtime.services),
              execution: createBackofficeSystemExecution(workspace),
            };
            const reason =
              "Workers AI runs in organization, user, project, and system scopes, not in an app workspace.";
            expect(await integration.discover(context)).toMatchObject([
              { id: "workers-ai", availability: { status: "unavailable", reason } },
            ]);
            expect(await integration.list(context, null)).toEqual({
              connections: [],
              cursor: null,
            });
            const connection = await integration.resolve(context, "workers-ai");
            assert((await connection.state()) === "unavailable");
            expect(await connection.verify()).toMatchObject({
              configuration: { status: "missing" },
              nextSteps: [reason],
            });
            await expect(connection.actions()).rejects.toThrow(reason);
            expect(ctx.fakes.workersAi?.runs).toEqual([]);
          },
        ),
      ],
    }),
  );
});
