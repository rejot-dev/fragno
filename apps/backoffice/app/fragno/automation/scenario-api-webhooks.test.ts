import { assert, describe, expect, test, vi } from "vitest";

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  return {
    DurableObject: MockDurableObject,
    RpcTarget: class MockRpcTarget {},
    WorkerEntrypoint: class MockWorkerEntrypoint {},
  };
});

vi.mock("cloudflare:workers", () => ({ DurableObject, RpcTarget, WorkerEntrypoint }));

import { apiSchema } from "@fragno-dev/api-fragment/schema";
import { RouterContextProvider } from "react-router";
import { z } from "zod";

import { migrate } from "@fragno-dev/db";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { encodeBackofficeObjectAddress, org } from "@/backoffice-runtime/object-registry";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
import { createApiServer } from "@/fragno/api";
import { bytesToHex } from "@/lib/crypto";
import { action as receiveApiWebhook } from "@/routes/api/api";
import { BackofficeWorkerContext } from "@/worker-runtime/router-context";

import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioStep,
} from "./scenario";

const ORG_ID = "org-1";
const ORG_SLUG = "ada-labs";
const ENDPOINT_ID = "slack";
const SLACK_SIGNING_SECRET = "scenario-slack-signing-secret";
const SLACK_CHALLENGE = "scenario-slack-challenge";
const SLACK_DELIVERY_ID = "Ev-scenario-123";
const ACME_ENDPOINT_ID = "acme";
const ACME_DELIVERY_ID = "evt-acme-123";
const LEGACY_PUT_ENDPOINT_ID = "legacy-put";
const LEGACY_PATCH_ENDPOINT_ID = "legacy-patch";
const FRESH_ENDPOINT_ID = "fresh-webhook";

const slackChallengeBody = {
  type: "url_verification",
  challenge: SLACK_CHALLENGE,
};
const slackDeliveryBody = {
  type: "event_callback",
  event_id: SLACK_DELIVERY_ID,
  event: { type: "message", text: "Scenario webhook delivery" },
};
const acmeDeliveryBody = {
  id: ACME_DELIVERY_ID,
  type: "record.created",
  recordId: "rec-123",
  data: { status: "new" },
};

const automationEventPageSchema = z.object({
  events: z.array(z.object({ source: z.string(), eventType: z.string() })),
});

type CapturedWebhookResponse = {
  status: number;
  contentType: string | null;
  body: string;
};

type ApiWebhookScenarioVars = {
  rejectedChallenge: CapturedWebhookResponse | null;
  acceptedChallenge: CapturedWebhookResponse | null;
  acceptedDelivery: CapturedWebhookResponse | null;
};

type EventSourceScenarioVars = {
  acceptedDelivery: CapturedWebhookResponse | null;
};

type WebhookResponseCapture = keyof ApiWebhookScenarioVars;

const createScenarioRouterContext = (ctx: BackofficeScenarioContext) => {
  const routerContext = new RouterContextProvider();
  routerContext.set(BackofficeWorkerContext, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
  return routerContext;
};

const getConfiguredWebhookPublicUrl = (ctx: BackofficeScenarioContext): string => {
  const result = ctx.codemodeRuns.at(-1)?.result.result;
  return z.object({ publicUrl: z.url() }).parse(result).publicUrl;
};

const signSlackWebhookBody = async ({
  secret,
  timestamp,
  body,
}: {
  secret: string;
  timestamp: string;
  body: string;
}): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
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
};

const postSlackWebhook = ({
  label,
  body,
  authenticate,
  captureAs,
}: {
  label: string;
  body: unknown;
  authenticate: boolean;
  captureAs: WebhookResponseCapture;
}): BackofficeScenarioStep => ({
  kind: "when",
  type: "api.webhook.post",
  label,
  async run(untypedContext) {
    const ctx = untypedContext as BackofficeScenarioContext<ApiWebhookScenarioVars>;
    const rawBody = JSON.stringify(body);
    const timestamp = `${Math.floor(ctx.runtime.now() / 1000)}`;
    const signature = authenticate
      ? await signSlackWebhookBody({
          secret: SLACK_SIGNING_SECRET,
          timestamp,
          body: rawBody,
        })
      : "v0=invalid-signature";
    const publicUrl = getConfiguredWebhookPublicUrl(ctx);
    const scopeSegment = backofficeRouteScopeSinglePathSegment({
      kind: "org",
      orgSlug: ORG_SLUG,
    });

    const response = await receiveApiWebhook({
      request: new Request(publicUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body: rawBody,
      }),
      context: createScenarioRouterContext(ctx),
      params: { scopeSegment },
    } as unknown as Parameters<typeof receiveApiWebhook>[0]);

    ctx.vars[captureAs] = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  },
});

const postAcmeWebhookDelivery = (): BackofficeScenarioStep => ({
  kind: "when",
  type: "api.webhook.post",
  label: "post an Acme record-created webhook delivery",
  async run(untypedContext) {
    const ctx = untypedContext as BackofficeScenarioContext<EventSourceScenarioVars>;
    const scopeSegment = backofficeContextScopeSinglePathSegment({
      kind: "org",
      orgId: ORG_ID,
    });
    const response = await receiveApiWebhook({
      request: new Request(
        `https://example.com/api/http/org%3A${ORG_ID}/webhooks/endpoints/${ACME_ENDPOINT_ID}/events`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(acmeDeliveryBody),
        },
      ),
      context: createScenarioRouterContext(ctx),
      params: { scopeSegment },
    } as unknown as Parameters<typeof receiveApiWebhook>[0]);

    ctx.vars.acceptedDelivery = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  },
});

const listApiEvents = async (ctx: BackofficeScenarioContext, eventType: string) => {
  const response = await ctx.runtime.objects.automations
    .forOrg(ORG_ID)
    .fetch(new Request("https://automations.test/api/automations/events?limit=100"));
  assert(response.ok);
  const page = automationEventPageSchema.parse(await response.json());
  return page.events.filter((event) => event.source === "api" && event.eventType === eventType);
};

const seedLegacyWebhookEndpoints = (): BackofficeScenarioStep => ({
  kind: "given",
  type: "api.webhook.seed-legacy-endpoints",
  label: "seed webhook endpoints created before event-source reconciliation",
  drain: false,
  async run(ctx) {
    const apiObjectName = encodeBackofficeObjectAddress({
      binding: "API",
      scope: org(ORG_ID),
    });
    const api = createApiServer(
      {},
      {
        adapters: ctx.runtime.adapters.forScope({
          type: "named",
          id: `API:${apiObjectName}`,
        }),
      },
    );
    await migrate(api);

    const uow = api.$internal.deps.createUnitOfWork().forSchema(apiSchema);
    for (const endpointId of [LEGACY_PUT_ENDPOINT_ID, LEGACY_PATCH_ENDPOINT_ID]) {
      uow.create("webhookEndpoint", {
        id: endpointId,
        name: "Legacy Webhook",
        status: "active",
        authConfig: { type: "none" },
        verification: { type: "none" },
        deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
      });
    }
    const result = await uow.executeMutations();
    assert(result.success);
  },
});

describe("API webhook scenarios", () => {
  test("existing webhook endpoint writes reconcile missing and stale event sources", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: "API webhook endpoint event-source reconciliation",
        setup: ({ given }) => [
          given.organization.exists({ id: ORG_ID, name: "Ada Labs" }),
          seedLegacyWebhookEndpoints(),
        ],
        steps: ({ when, then }) => [
          then.assert("legacy endpoints start without event sources", async (ctx) => {
            const automations = ctx.runtime.objects.automations.forOrg(ORG_ID);
            await expect(
              Promise.all([
                automations.getEventSource({ source: LEGACY_PUT_ENDPOINT_ID }),
                automations.getEventSource({ source: LEGACY_PATCH_ENDPOINT_ID }),
              ]),
            ).resolves.toEqual([null, null]);
          }),
          when.codemode.run({
            orgId: ORG_ID,
            label: "replace a legacy webhook endpoint through PUT",
            code: `async () => await api.createWebhookEndpoint(${JSON.stringify({
              endpointId: LEGACY_PUT_ENDPOINT_ID,
              name: "PUT Reconciled Webhook",
              status: "active",
              verification: { type: "none" },
              deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
              auth: { type: "none" },
            })})`,
            assertToolCalls: ["api.webhooks.create"],
          }),
          then.assert("PUT provisions the missing event source", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .forOrg(ORG_ID)
                .getEventSource({ source: LEGACY_PUT_ENDPOINT_ID }),
            ).resolves.toMatchObject({
              source: LEGACY_PUT_ENDPOINT_ID,
              label: "PUT Reconciled Webhook",
              description: "PUT Reconciled Webhook webhook events received through the API.",
              category: "custom",
            });
          }),
          when.codemode.run({
            orgId: ORG_ID,
            label: "rename a legacy webhook endpoint through PATCH",
            code: `async () => await api.updateWebhookEndpoint(${JSON.stringify({
              endpointId: LEGACY_PATCH_ENDPOINT_ID,
              name: "PATCH Reconciled Webhook",
            })})`,
            assertToolCalls: ["api.webhooks.update"],
          }),
          then.assert("PATCH provisions the missing source with renamed metadata", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .forOrg(ORG_ID)
                .getEventSource({ source: LEGACY_PATCH_ENDPOINT_ID }),
            ).resolves.toMatchObject({
              source: LEGACY_PATCH_ENDPOINT_ID,
              label: "PATCH Reconciled Webhook",
              description: "PATCH Reconciled Webhook webhook events received through the API.",
              category: "custom",
            });
          }),
          when.codemode.run({
            orgId: ORG_ID,
            label: "disable the PATCH-reconciled endpoint without renaming it",
            code: `async () => await api.updateWebhookEndpoint(${JSON.stringify({
              endpointId: LEGACY_PATCH_ENDPOINT_ID,
              status: "disabled",
            })})`,
            assertToolCalls: ["api.webhooks.update"],
          }),
          then.assert("status-only PATCH preserves event-source metadata", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .forOrg(ORG_ID)
                .getEventSource({ source: LEGACY_PATCH_ENDPOINT_ID }),
            ).resolves.toMatchObject({
              label: "PATCH Reconciled Webhook",
              description: "PATCH Reconciled Webhook webhook events received through the API.",
            });
          }),
          when.codemode.run({
            orgId: ORG_ID,
            label: "create a fresh webhook endpoint",
            code: `async () => await api.createWebhookEndpoint(${JSON.stringify({
              endpointId: FRESH_ENDPOINT_ID,
              name: "Fresh Webhook",
              status: "active",
              verification: { type: "none" },
              deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
              auth: { type: "none" },
            })})`,
            assertToolCalls: ["api.webhooks.create"],
          }),
          then.automation.event({
            scope: { kind: "org", orgId: ORG_ID },
            where: { source: "api", eventType: "webhook_endpoint.created" },
            expected: {
              payload: {
                endpointId: FRESH_ENDPOINT_ID,
                name: "Fresh Webhook",
                status: "active",
                authConfig: { type: "none" },
                verification: { type: "none" },
                deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
                secretRefs: [],
              },
            },
          }),
          then.assert("only the fresh endpoint emitted a creation event", async (ctx) => {
            await expect(listApiEvents(ctx, "webhook_endpoint.created")).resolves.toHaveLength(1);
          }),
          then.hooks.noPending({ orgId: ORG_ID, fragments: ["api", "automations"] }),
          then.hooks.noFailed({ orgId: ORG_ID, fragments: ["api", "automations"] }),
        ],
      }),
    );
  });

  test("a webhook endpoint provisions a source for cataloged and reclassified events", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<EventSourceScenarioVars>({
        name: "API webhook event source, catalog, and routing",
        vars: () => ({ acceptedDelivery: null }),
        setup: ({ given }) => [given.organization.exists({ id: ORG_ID, name: "Ada Labs" })],
        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: ORG_ID,
            label: "create an active Acme webhook endpoint",
            code: `async () => await api.createWebhookEndpoint(${JSON.stringify({
              endpointId: ACME_ENDPOINT_ID,
              name: "Acme",
              status: "active",
              verification: { type: "none" },
              deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
              auth: { type: "none" },
            })})`,
            assertToolCalls: ["api.webhooks.create"],
          }),
          then.assert("the endpoint provisioned its dynamic event source", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations
                .forOrg(ORG_ID)
                .getEventSource({ source: ACME_ENDPOINT_ID }),
            ).resolves.toMatchObject({
              source: ACME_ENDPOINT_ID,
              label: "Acme",
              description: "Acme webhook events received through the API.",
              category: "custom",
            });
          }),
          then.automation.event({
            scope: { kind: "org", orgId: ORG_ID },
            where: { source: "api", eventType: "webhook_endpoint.created" },
            expected: {
              payload: {
                endpointId: ACME_ENDPOINT_ID,
                name: "Acme",
                status: "active",
                authConfig: { type: "none" },
                verification: { type: "none" },
                deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
                secretRefs: [],
              },
              subject: {
                scope: { kind: "org", orgId: ORG_ID },
                orgId: ORG_ID,
                endpointId: ACME_ENDPOINT_ID,
              },
            },
          }),
          when.codemode.run({
            orgId: ORG_ID,
            label: "register Acme record-created events under the webhook source",
            code: `async () => await events.catalogCreate(${JSON.stringify({
              source: ACME_ENDPOINT_ID,
              eventType: "record.created",
              label: "Acme record created",
              description: "A record was created in Acme.",
              payloadSchema: {
                type: "object",
                properties: {
                  recordId: { type: "string" },
                  data: { type: "object" },
                },
                required: ["recordId", "data"],
                additionalProperties: false,
              },
              example: { recordId: "rec-123", data: { status: "new" } },
              enabled: true,
            })})`,
            assertToolCalls: ["events.catalog.create"],
          }),
          then.assert("the webhook source owns the registered event definition", async (ctx) => {
            await expect(
              ctx.runtime.objects.automations.forOrg(ORG_ID).getEventDefinition({
                source: ACME_ENDPOINT_ID,
                eventType: "record.created",
              }),
            ).resolves.toMatchObject({
              source: ACME_ENDPOINT_ID,
              eventType: "record.created",
              label: "Acme record created",
              enabled: true,
            });
          }),
          when.codemode.run({
            orgId: ORG_ID,
            label: "route Acme webhook deliveries into the cataloged event",
            code: `async () => await router.create(${JSON.stringify({
              id: "acme-record-created",
              name: "Classify Acme record-created webhooks",
              enabled: true,
              trigger: {
                kind: "event",
                source: "api",
                eventType: "webhook.received",
                matcher: {
                  all: [
                    {
                      path: "$.payload.endpointId",
                      op: "eq",
                      value: ACME_ENDPOINT_ID,
                    },
                    {
                      path: "$.payload.body.type",
                      op: "eq",
                      value: "record.created",
                    },
                  ],
                },
              },
              action: {
                kind: "reclassify_event",
                source: ACME_ENDPOINT_ID,
                eventType: "record.created",
                payload: {
                  kind: "projection",
                  fields: {
                    recordId: "$.payload.body.recordId",
                    data: "$.payload.body.data",
                  },
                },
              },
              description: "Reclassifies Acme webhook deliveries as Acme record-created events.",
            })})`,
            assertToolCalls: ["router.create"],
          }),
          then.router.route({
            orgId: ORG_ID,
            id: "acme-record-created",
            trigger: {
              kind: "event",
              source: "api",
              eventType: "webhook.received",
              matcher: {
                all: [
                  { path: "$.payload.endpointId", op: "eq", value: ACME_ENDPOINT_ID },
                  { path: "$.payload.body.type", op: "eq", value: "record.created" },
                ],
              },
            },
            action: {
              kind: "reclassify_event",
              source: ACME_ENDPOINT_ID,
              eventType: "record.created",
              payload: {
                kind: "projection",
                fields: {
                  recordId: "$.payload.body.recordId",
                  data: "$.payload.body.data",
                },
              },
            },
          }),
          postAcmeWebhookDelivery(),
          then.assert("the Acme delivery is accepted asynchronously", (untypedContext) => {
            const ctx = untypedContext as BackofficeScenarioContext<EventSourceScenarioVars>;
            expect(ctx.vars.acceptedDelivery).toMatchObject({
              status: 202,
              body: JSON.stringify({ accepted: true }),
            });
          }),
          then.automation.event({
            scope: { kind: "org", orgId: ORG_ID },
            where: { source: "api", eventType: "webhook.received" },
            expected: {
              payload: {
                endpointId: ACME_ENDPOINT_ID,
                deliveryId: ACME_DELIVERY_ID,
                body: acmeDeliveryBody,
              },
            },
          }),
          then.automation.event({
            scope: { kind: "org", orgId: ORG_ID },
            where: { source: ACME_ENDPOINT_ID, eventType: "record.created" },
            expected: {
              payload: {
                recordId: "rec-123",
                data: { status: "new" },
              },
            },
          }),
          then.hooks.noPending({ orgId: ORG_ID, fragments: ["api", "automations"] }),
          then.hooks.noFailed({ orgId: ORG_ID, fragments: ["api", "automations"] }),
        ],
      }),
    );
  });

  test("Slack verification authenticates and echoes before normal deliveries reach automations", async () => {
    await runBackofficeScenario(
      defineBackofficeScenario<ApiWebhookScenarioVars>({
        name: "Slack webhook verification and delivery",
        vars: () => ({
          rejectedChallenge: null,
          acceptedChallenge: null,
          acceptedDelivery: null,
        }),
        setup: ({ given }) => [
          given.organization.exists({ id: ORG_ID, slug: ORG_SLUG, name: "Ada Labs" }),
        ],
        steps: ({ when, then }) => [
          when.codemode.run({
            orgId: ORG_ID,
            label: "configure a Slack webhook endpoint through the API runtime tool",
            code: `async () => await api.createWebhookEndpoint(${JSON.stringify({
              endpointId: ENDPOINT_ID,
              name: "Slack",
              status: "active",
              verification: {
                type: "challenge",
                method: "POST",
                when: {
                  type: "equals",
                  source: { type: "jsonBodyPath", path: ["type"] },
                  value: "url_verification",
                },
                response: {
                  type: "echoText",
                  source: { type: "jsonBodyPath", path: ["challenge"] },
                },
              },
              deliveryIdentity: { type: "jsonBodyPath", path: ["event_id"] },
              auth: {
                type: "hmac",
                secret: SLACK_SIGNING_SECRET,
                algorithm: "sha256",
                signature: {
                  location: "header",
                  name: "x-slack-signature",
                  encoding: "hex",
                  prefix: "v0=",
                },
                signedPayload: {
                  type: "timestampedBody",
                  prefix: "v0:",
                  timestampHeader: "x-slack-request-timestamp",
                  delimiter: ":",
                  toleranceSeconds: 300,
                },
              },
            })})`,
            assertToolCalls: ["api.webhooks.create"],
          }),
          then.assert("the runtime tool returns the scoped public webhook URL", (ctx) => {
            expect(getConfiguredWebhookPublicUrl(ctx)).toBe(
              `https://example.com/api/http/org%3A${ORG_SLUG}/webhooks/endpoints/${ENDPOINT_ID}/events`,
            );
          }),
          postSlackWebhook({
            label: "post a Slack challenge with an invalid signature",
            body: slackChallengeBody,
            authenticate: false,
            captureAs: "rejectedChallenge",
          }),
          then.assert("the unauthenticated challenge is rejected", (untypedContext) => {
            const ctx = untypedContext as BackofficeScenarioContext<ApiWebhookScenarioVars>;
            expect(ctx.vars.rejectedChallenge).toMatchObject({ status: 401 });
          }),
          postSlackWebhook({
            label: "post an authenticated Slack URL verification challenge",
            body: slackChallengeBody,
            authenticate: true,
            captureAs: "acceptedChallenge",
          }),
          then.assert("the authenticated challenge is echoed as plain text", (untypedContext) => {
            const ctx = untypedContext as BackofficeScenarioContext<ApiWebhookScenarioVars>;
            expect(ctx.vars.acceptedChallenge).toEqual({
              status: 200,
              contentType: "text/plain; charset=utf-8",
              body: SLACK_CHALLENGE,
            });
          }),
          then.assert("verification requests do not create automation events", async (ctx) => {
            await expect(listApiEvents(ctx, "webhook.received")).resolves.toEqual([]);
          }),
          postSlackWebhook({
            label: "post an authenticated Slack event delivery",
            body: slackDeliveryBody,
            authenticate: true,
            captureAs: "acceptedDelivery",
          }),
          then.assert("the normal delivery is accepted asynchronously", (untypedContext) => {
            const ctx = untypedContext as BackofficeScenarioContext<ApiWebhookScenarioVars>;
            expect(ctx.vars.acceptedDelivery).toMatchObject({ status: 202 });
          }),
          then.automation.event({
            scope: { kind: "org", orgId: ORG_ID },
            where: { source: "api", eventType: "webhook.received" },
            expected: {
              payload: {
                endpointId: ENDPOINT_ID,
                deliveryId: SLACK_DELIVERY_ID,
                headers: { "x-slack-signature": "[redacted]" },
                body: slackDeliveryBody,
              },
              subject: {
                scope: { kind: "org", orgId: ORG_ID },
                orgId: ORG_ID,
                endpointId: ENDPOINT_ID,
                deliveryId: SLACK_DELIVERY_ID,
              },
            },
          }),
          then.hooks.noPending({ orgId: ORG_ID, fragments: ["api"] }),
        ],
      }),
    );
  });
});
