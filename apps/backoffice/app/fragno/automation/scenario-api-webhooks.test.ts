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

import { RouterContextProvider } from "react-router";
import { z } from "zod";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { backofficeContextScopeSinglePathSegment } from "@/backoffice-runtime/scope-codec";
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
const ENDPOINT_ID = "slack";
const SLACK_SIGNING_SECRET = "scenario-slack-signing-secret";
const SLACK_CHALLENGE = "scenario-slack-challenge";
const SLACK_DELIVERY_ID = "Ev-scenario-123";

const slackChallengeBody = {
  type: "url_verification",
  challenge: SLACK_CHALLENGE,
};
const slackDeliveryBody = {
  type: "event_callback",
  event_id: SLACK_DELIVERY_ID,
  event: { type: "message", text: "Scenario webhook delivery" },
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
    const scopeSegment = backofficeContextScopeSinglePathSegment({
      kind: "org",
      orgId: ORG_ID,
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

const listApiWebhookEvents = async (ctx: BackofficeScenarioContext) => {
  const response = await ctx.runtime.objects.automations
    .forOrg(ORG_ID)
    .fetch(new Request("https://automations.test/api/automations/events?limit=100"));
  assert(response.ok);
  const page = automationEventPageSchema.parse(await response.json());
  return page.events.filter(
    (event) => event.source === "api" && event.eventType === "webhook.received",
  );
};

describe("API webhook scenarios", () => {
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
          given.organization.exists({ id: ORG_ID, name: "Ada Labs" }),
          given.connection.configured({ orgId: ORG_ID, id: "api" }),
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
              `https://example.com/api/http/org%3A${ORG_ID}/webhooks/endpoints/${ENDPOINT_ID}/events`,
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
            await expect(listApiWebhookEvents(ctx)).resolves.toEqual([]);
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
