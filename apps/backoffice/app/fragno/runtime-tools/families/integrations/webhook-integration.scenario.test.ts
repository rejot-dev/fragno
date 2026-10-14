import { assert, expect, test, vi } from "vitest";

import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { bytesToHex } from "@/lib/crypto";
import { action as receiveApiWebhook } from "@/routes/api/api";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../../../workers/api.do";
import { InMemoryAppInstallationsObject } from "../../../../../workers/app-installations.do";
import { InMemoryAppsObject } from "../../../../../workers/apps.do";
import { InMemoryAuthObject } from "../../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../../workers/automations.do";
import { InMemoryCodemodeObject } from "../../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../../workers/forms.do";
import { InMemoryGitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router.do";
import { InMemoryGitHubObject } from "../../../../../workers/github.do";
import { InMemoryMcpObject } from "../../../../../workers/mcp.do";
import { InMemoryOtpObject } from "../../../../../workers/otp.do";
import { InMemoryProjectConnectorObject } from "../../../../../workers/project-connector.do";
import { InMemoryResendObject } from "../../../../../workers/resend.do";
import { InMemoryReson8Object } from "../../../../../workers/reson8.do";
import { InMemoryTelegramObject } from "../../../../../workers/telegram.do";
import { InMemoryUploadObject } from "../../../../../workers/upload.do";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  APPS: (input) => new InMemoryAppsObject(input),
  APP_INSTALLATIONS: (input) => new InMemoryAppInstallationsObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  GITHUB: (input) => new InMemoryGitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new InMemoryGitHubWebhookRouterObject(input),
  MCP: (input) => new InMemoryMcpObject(input),
  OTP: (input) => new InMemoryOtpObject(input),
  PROJECT_CONNECTOR: (input) => new InMemoryProjectConnectorObject(input),
  RESEND: (input) => new InMemoryResendObject(input),
  RESON8: (input) => new InMemoryReson8Object(input),
  TELEGRAM: (input) => new InMemoryTelegramObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "webhook-org";
const orgSlug = "ada-labs";
const scope = { kind: "org", orgId } as const;
const signingSecret = "scenario-slack-signing-secret";
const publicUrl = (endpointId: string) =>
  `https://example.com/api/http/org%3A${orgSlug}/webhooks/endpoints/${endpointId}/events`;
const slackContract = {
  name: "Slack",
  verification: {
    type: "challenge",
    method: "POST",
    when: {
      type: "equals",
      source: { type: "jsonBodyPath", path: ["type"] },
      value: "url_verification",
    },
    response: { type: "echoText", source: { type: "jsonBodyPath", path: ["challenge"] } },
  },
  deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
  auth: {
    type: "hmac",
    secret: signingSecret,
    algorithm: "sha256",
    signature: { location: "header", name: "x-slack-signature", encoding: "hex", prefix: "v0=" },
    signedPayload: {
      type: "timestampedBody",
      prefix: "v0:",
      timestampHeader: "x-slack-request-timestamp",
      delimiter: ":",
      toleranceSeconds: 300,
    },
  },
};

async function signSlackBody(timestamp: string, body: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`),
  );
  return `v0=${bytesToHex(new Uint8Array(signature))}`;
}

/** Posts to the public receive route the way a provider would. */
async function post(
  ctx: BackofficeScenarioContext,
  endpointId: string,
  body: unknown,
  headers: Record<string, string>,
) {
  const request = new Request(publicUrl(endpointId), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const response = await receiveApiWebhook({
    request,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: { scopeSegment: backofficeRouteScopeSinglePathSegment({ kind: "org", orgSlug }) },
  } as unknown as Parameters<typeof receiveApiWebhook>[0]);
  return { status: response.status, body: await response.text() };
}

async function postSlack(ctx: BackofficeScenarioContext, body: unknown, signed: boolean) {
  const rawBody = JSON.stringify(body);
  const timestamp = `${Math.floor(ctx.runtime.now() / 1000)}`;
  return await post(ctx, "slack", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signed ? await signSlackBody(timestamp, rawBody) : "v0=invalid",
  });
}

async function verifySlack(ctx: BackofficeScenarioContext) {
  const run = await ctx.runCodemode({
    scope,
    code: `async () => await integrations.verify({ connectionId: "webhook#slack" })`,
    assertToolCalls: ["integrations.verify"],
  });
  return run.result;
}

async function automationEvents(ctx: BackofficeScenarioContext) {
  const response = await ctx.runtime.objects.automations
    .for(scope)
    .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
  assert(response.ok, await response.clone().text());
  return automationEventListResultSchema.parse(await response.json()).events;
}

async function connectionEventTypes(ctx: BackofficeScenarioContext, connectionId: string) {
  return (await automationEvents(ctx))
    .filter(
      (event) => event.source === "integrations" && event.subject?.connectionId === connectionId,
    )
    .map((event) => event.eventType)
    .sort();
}

test("a webhook endpoint is set up, proves deliveries, and disconnects through integrations", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Inbound webhook lifecycle through the integrations facade",
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: orgSlug, name: "Ada" })],
      steps: ({ then, runner }) => [
        then.assert("setup hands out the URL before it activates the endpoint", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "webhook#slack" };
              const service = (await integrations.discover()).find((item) => item.id === "webhook");
              const before = await integrations.setup({ ...target, kind: "check" });
              const reserved = await integrations.setup({ connectionId: "webhook#telegram", kind: "check" });
              const ready = await integrations.setup({ ...target, kind: "input", input: ${JSON.stringify(slackContract)} });
              const described = await integrations.execute({ ...target, actionId: "endpoint.describe", input: {} });
              return { service, before, reserved, ready, described, verified: await integrations.verify(target) };
            }`,
            assertToolCalls: ["integrations.setup", "integrations.execute", "integrations.verify"],
          });
          expect(run.result).toMatchObject({
            service: {
              availability: { status: "available" },
              automationEvents: [{ source: "api", eventType: "webhook.received" }],
            },
            before: {
              status: "needs-input",
              instructions: expect.stringContaining(publicUrl("slack")),
              secretFields: expect.arrayContaining(["auth.secret"]),
            },
            reserved: {
              status: "blocked",
              reason: expect.stringContaining("already declares the 'telegram' source"),
            },
            ready: { status: "ready", connectionId: "webhook#slack" },
            described: {
              endpointId: "slack",
              publicUrl: publicUrl("slack"),
              status: "active",
              authConfig: { type: "hmac" },
              deliveries: { lastAcceptedAt: null, lastRejection: null },
            },
            verified: {
              configuration: { status: "configured" },
              authorization: { status: "available" },
              checks: [{ id: "delivery.received", status: "not-checked" }],
              nextSteps: [expect.stringContaining(publicUrl("slack"))],
            },
          });
          expect(JSON.stringify(run.result)).not.toContain(signingSecret);
        }),
        runner.drain(),
        then.automation.event({
          scope,
          where: { source: "integrations", eventType: "connection.ready" },
          expected: { subject: { service: "webhook", connectionId: "webhook#slack" } },
        }),
        then.assert("a forged challenge fails verification", async (ctx) => {
          const challenge = { type: "url_verification", challenge: "scenario-challenge" };
          expect(await postSlack(ctx, challenge, false)).toMatchObject({ status: 401 });
          expect(await verifySlack(ctx)).toMatchObject({
            checks: [
              {
                status: "failed",
                message: expect.stringContaining("authentication failed"),
              },
            ],
            nextSteps: [expect.stringContaining("Correct the provider's webhook settings")],
          });
        }),
        then.assert("an answered challenge and a delivery pass verification", async (ctx) => {
          const challenge = { type: "url_verification", challenge: "scenario-challenge" };
          expect(await postSlack(ctx, challenge, true)).toEqual({
            status: 200,
            body: "scenario-challenge",
          });
          const delivery = { type: "event_callback", event_id: "Ev-1", event: { type: "message" } };
          expect(await postSlack(ctx, delivery, true)).toMatchObject({ status: 202 });
          expect(await verifySlack(ctx)).toMatchObject({
            checks: [{ status: "passed", message: "Accepted the latest request." }],
            nextSteps: [],
          });
        }),
        runner.drain(),
        then.automation.event({
          scope,
          where: { source: "api", eventType: "webhook.received" },
          expected: {
            payload: { endpointId: "slack", deliveryId: "Ev-1" },
            subject: { endpointId: "slack", deliveryId: "Ev-1" },
          },
        }),
        then.assert("a rename from the stored settings keeps the signing secret", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "webhook#slack" };
              const before = await integrations.reconfigure({ ...target, kind: "check" });
              const { settings } = await integrations.get(target);
              const ready = await integrations.reconfigure({ ...target, kind: "input", input: {
                ...settings, name: "Slack Events",
              } });
              return { before, settings, ready, verified: await integrations.verify(target) };
            }`,
            assertToolCalls: [
              "integrations.reconfigure",
              "integrations.get",
              "integrations.verify",
            ],
          });
          expect(JSON.stringify(run.result)).not.toContain(signingSecret);
          const { auth: _auth, ...contract } = slackContract;
          expect(run.result).toMatchObject({
            before: { status: "needs-input", instructions: expect.stringContaining('"keep"') },
            settings: { ...contract, auth: { type: "keep" } },
            ready: { status: "ready" },
            // Outcomes describe the configuration they were collected under.
            verified: { checks: [{ status: "not-checked" }] },
          });
          const delivery = { type: "event_callback", event_id: "Ev-2", event: { type: "message" } };
          expect(await postSlack(ctx, delivery, true)).toMatchObject({ status: 202 });
          await ctx.drain();
          await expect(
            ctx.runtime.objects.automations.for(scope).commands.getEventSource({ source: "slack" }),
          ).resolves.toMatchObject({ label: "Slack Events" });
          // The endpoint stayed active, so the write reported no readiness change.
          expect(await connectionEventTypes(ctx, "webhook#slack")).toEqual(["connection.ready"]);
        }),
        then.assert("disconnect removes the endpoint and its URL", async (ctx) => {
          const run = await ctx.runCodemode({
            scope,
            code: `async () => {
              const target = { connectionId: "webhook#slack" };
              const disconnected = await integrations.disconnect({ ...target, confirm: "webhook#slack" });
              const again = await integrations.disconnect({ ...target, confirm: "webhook#slack" });
              return { disconnected, again, inspected: await integrations.get(target) };
            }`,
            assertToolCalls: ["integrations.disconnect", "integrations.get"],
          });
          expect(run.result).toMatchObject({
            disconnected: { status: "disconnected" },
            again: { status: "not-configured" },
            inspected: { configuration: { status: "missing" } },
          });
          const delivery = { type: "event_callback", event_id: "Ev-3", event: { type: "message" } };
          expect(await postSlack(ctx, delivery, true)).toMatchObject({ status: 404 });
          await ctx.drain();
          expect(await connectionEventTypes(ctx, "webhook#slack")).toEqual([
            "connection.disconnected",
            "connection.ready",
          ]);
        }),
        then.hooks.noFailed({ orgId, fragments: ["api", "automations"] }),
      ],
    }),
  );
});

test("an endpoint's deliveries are reclassified into its own cataloged events", async () => {
  const delivery = { id: "evt-acme-1", type: "record.created", recordId: "rec-1", data: {} };
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Inbound webhook event source, catalog, and routing",
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: orgSlug, name: "Ada" })],
      steps: ({ when, then }) => [
        when.codemode.run({
          scope,
          label: "set up an Acme webhook, catalog its event, and route deliveries into it",
          code: `async () => {
            await integrations.setup({ connectionId: "webhook#acme", kind: "input", input: ${JSON.stringify(
              {
                name: "Acme",
                verification: { type: "none" },
                deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
                auth: { type: "none" },
              },
            )} });
            await events.catalogCreate(${JSON.stringify({
              source: "acme",
              eventType: "record.created",
              label: "Acme record created",
              payloadSchema: {
                type: "object",
                properties: { recordId: { type: "string" }, data: { type: "object" } },
                required: ["recordId", "data"],
                additionalProperties: false,
              },
              enabled: true,
            })});
            await router.create(${JSON.stringify({
              id: "acme-record-created",
              name: "Classify Acme record-created webhooks",
              enabled: true,
              trigger: {
                kind: "event",
                source: "api",
                eventType: "webhook.received",
                matcher: {
                  all: [
                    { path: "$.payload.endpointId", op: "eq", value: "acme" },
                    { path: "$.payload.body.type", op: "eq", value: "record.created" },
                  ],
                },
              },
              action: {
                kind: "reclassify_event",
                source: "acme",
                eventType: "record.created",
                payload: {
                  kind: "projection",
                  fields: { recordId: "$.payload.body.recordId", data: "$.payload.body.data" },
                },
              },
            })});
          }`,
          assertToolCalls: ["integrations.setup", "events.catalog.create", "router.create"],
        }),
        then.assert("the endpoint provisioned its event source", async (ctx) => {
          await expect(
            ctx.runtime.objects.automations.for(scope).commands.getEventSource({ source: "acme" }),
          ).resolves.toMatchObject({ source: "acme", label: "Acme", category: "custom" });
          expect(await post(ctx, "acme", delivery, {})).toMatchObject({ status: 202 });
          await ctx.drain();
        }),
        then.automation.event({
          scope,
          where: { source: "acme", eventType: "record.created" },
          expected: { payload: { recordId: "rec-1", data: {} } },
        }),
        then.hooks.noPending({ orgId, fragments: ["api", "automations"] }),
        then.hooks.noFailed({ orgId, fragments: ["api", "automations"] }),
      ],
    }),
  );
});
