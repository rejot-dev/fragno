import { assert, expect, test, vi } from "vitest";

import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";

import { InMemoryApiObject } from "../../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../../workers/automations.do";
import { InMemoryBillingObject } from "../../../../../workers/billing.do";
import { InMemoryCodemodeObject } from "../../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../../../../workers/github.do";
import { InMemoryMcpObject } from "../../../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../../../workers/otp.do";
import { InMemoryProjectConnectorObject } from "../../../../../workers/project-connector.do";
import { InMemoryResendObject } from "../../../../../workers/resend.do";
import { InMemoryTelegramObject } from "../../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../../workers/upload.do";
import { recordIntegrationConnectionState } from "./integration-events";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  BILLING: (input) => new InMemoryBillingObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "backfill-org";
const scope = { kind: "org", orgId } as const;

/** Event IDs the backfill recorded, in the order the events list returns them. */
async function backfilledEventIds(ctx: BackofficeScenarioContext) {
  const response = await ctx.runtime.objects.automations
    .for(scope)
    .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
  assert(response.ok, await response.clone().text());
  return automationEventListResultSchema
    .parse(await response.json())
    .events.map((event) => event.id)
    .filter((id) => id.startsWith("integrations-backfill:"))
    .sort();
}

async function backfill(ctx: BackofficeScenarioContext) {
  const run = await ctx.runCodemode({
    scope,
    code: `async () => await integrations.backfillConnectionEvents()`,
    assertToolCalls: ["integrations.backfillConnectionEvents"],
  });
  return run.result;
}

test("a backfill records each connection's current state once", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Integration connection events backfill",
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: "ada", name: "Ada" })],
      steps: ({ when, then, runner }) => [
        when.codemode.run({
          scope,
          label: "set up an API connection and an inbound webhook",
          code: `async () => {
            await integrations.setup({ connectionId: "api#billing", kind: "input", input: {
              baseUrl: "https://billing.example.com", type: "bearer", token: "scenario-token",
            } });
            await integrations.setup({ connectionId: "webhook#acme", kind: "input", input: {
              name: "Acme",
              verification: { type: "none" },
              deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
              auth: { type: "none" },
            } });
          }`,
          assertToolCalls: ["integrations.setup"],
        }),
        then.assert("the Backoffice API page disables the webhook endpoint", async (ctx) => {
          const response = await ctx.runtime.objects.api.for(scope).http.fetchAuthorized(
            new Request("https://api.do/api/api/webhooks/endpoints/acme", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "disabled" }),
            }),
            { execution: createBackofficeSystemExecution(scope) },
          );
          assert(response.ok, await response.clone().text());
        }),
        runner.drain(),
        then.assert("the backfill reports each source's own state", async (ctx) => {
          // A disabled endpoint keeps configuration and credentials, yet rejects deliveries.
          expect(await backfill(ctx)).toEqual({
            connections: [
              { connectionId: "api#billing", service: "api", state: "ready" },
              { connectionId: "webhook#acme", service: "webhook", state: "unavailable" },
            ],
          });
          await ctx.drain();
          expect(await backfilledEventIds(ctx)).toEqual([
            'integrations-backfill:api#billing:["billing","bearer"]:connection.ready',
            'integrations-backfill:webhook#acme:["Acme","none"]:connection.unavailable',
          ]);
        }),
        then.automation.event({
          scope,
          where: {
            source: "integrations",
            eventType: "connection.unavailable",
            id: 'integrations-backfill:webhook#acme:["Acme","none"]:connection.unavailable',
          },
          expected: {
            payload: { name: "Acme", authMethod: "none" },
            subject: { service: "webhook", connectionId: "webhook#acme" },
          },
        }),
        then.assert("a rerun with unchanged states records nothing new", async (ctx) => {
          await backfill(ctx);
          await ctx.drain();
          expect(await backfilledEventIds(ctx)).toHaveLength(2);
        }),
        then.assert("the Backoffice API page renames the webhook endpoint", async (ctx) => {
          const response = await ctx.runtime.objects.api.for(scope).http.fetchAuthorized(
            new Request("https://api.do/api/api/webhooks/endpoints/acme", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "Acme Corp" }),
            }),
            { execution: createBackofficeSystemExecution(scope) },
          );
          assert(response.ok, await response.clone().text());
        }),
        runner.drain(),
        then.assert(
          "a rerun records the new name the unchanged state did not report",
          async (ctx) => {
            await backfill(ctx);
            await ctx.drain();
            expect(await backfilledEventIds(ctx)).toEqual([
              'integrations-backfill:api#billing:["billing","bearer"]:connection.ready',
              'integrations-backfill:webhook#acme:["Acme Corp","none"]:connection.unavailable',
              'integrations-backfill:webhook#acme:["Acme","none"]:connection.unavailable',
            ]);
          },
        ),
        then.hooks.noFailed({ orgId, fragments: ["api", "automations"] }),
      ],
    }),
  );
});

test("a backfill disconnects connections whose integration was removed", async () => {
  const removedReadyEventId = "reson8-slot:connection.ready";
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Integration connection events backfill after a source is removed",
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: "ada", name: "Ada" })],
      steps: ({ when, then, runner }) => [
        when.codemode.run({
          scope,
          label: "set up an API connection",
          code: `async () => await integrations.setup({ connectionId: "api#billing", kind: "input", input: {
            baseUrl: "https://billing.example.com", type: "bearer", token: "scenario-token",
          } })`,
          assertToolCalls: ["integrations.setup"],
        }),
        then.assert("a removed integration's last report is still on record", async (ctx) => {
          // As the Reson8 object's outbox reported it before Reson8 stopped being an integration.
          await recordIntegrationConnectionState(
            ctx.runtime.objects.automations.for(scope).commands,
            {
              id: "reson8-slot",
              scope,
              service: "reson8",
              connectionId: "backoffice#reson8",
              state: "ready",
              label: { name: "Reson8", authMethod: "api-key" },
              occurredAt: new Date("2026-01-01T00:00:00.000Z"),
            },
            { propagationContext: null },
          );
        }),
        runner.drain(),
        then.assert("the backfill disconnects only the unowned address", async (ctx) => {
          expect(await backfill(ctx)).toEqual({
            connections: [
              { connectionId: "api#billing", service: "api", state: "ready" },
              { connectionId: "backoffice#reson8", service: "reson8", state: "disconnected" },
            ],
          });
        }),
        runner.drain(),
        then.automation.event({
          scope,
          where: {
            source: "integrations",
            eventType: "connection.disconnected",
            id: `integrations-backfill:backoffice#reson8:${removedReadyEventId}:connection.disconnected`,
          },
          expected: { subject: { service: "reson8", connectionId: "backoffice#reson8" } },
        }),
        then.assert("a rerun leaves the disconnected address alone", async (ctx) => {
          expect(await backfill(ctx)).toEqual({
            connections: [{ connectionId: "api#billing", service: "api", state: "ready" }],
          });
          await ctx.drain();
          expect(await backfilledEventIds(ctx)).toEqual([
            'integrations-backfill:api#billing:["billing","bearer"]:connection.ready',
            `integrations-backfill:backoffice#reson8:${removedReadyEventId}:connection.disconnected`,
          ]);
        }),
        then.hooks.noFailed({ orgId, fragments: ["api", "automations"] }),
      ],
    }),
  );
});
