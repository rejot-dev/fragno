import { assert, expect, test, vi } from "vitest";

import { createHmac } from "node:crypto";

import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryResendObject } from "../../../workers/resend.do";
import { action, loader } from "./resend";

const origin = "https://backoffice.example";
const signingKey = Buffer.from("resend-webhook-scenario-signing-key");
const webhookSecret = `whsec_${signingKey.toString("base64")}`;
const webhookCases = [
  { scope: { kind: "system" }, scopePathSegment: "system" },
  { scope: { kind: "system" }, scopePathSegment: "%73ystem" },
  { scope: { kind: "org", orgId: "resend-org" }, scopePathSegment: "org:resend-org" },
  { scope: { kind: "org", orgId: "resend-org" }, scopePathSegment: "org%3Aresend-org" },
  { scope: { kind: "org", orgId: "resend-org" }, scopePathSegment: "org%3aresend-org" },
] as const;

async function callPublicResend(
  ctx: BackofficeScenarioContext,
  input: {
    scope: BackofficeContextScope;
    scopePathSegment: string;
    method: "GET" | "POST";
    suffix: string;
    headers: HeadersInit;
    body: string;
  },
) {
  const scopeSegment = backofficeScopePathSegment(input.scope);
  const url = new URL(`/api/resend/${input.scopePathSegment}${input.suffix}`, origin);
  const request = new Request(url, {
    method: input.method,
    headers: input.headers,
    ...(input.method === "POST" ? { body: input.body } : {}),
  });
  const args = {
    request,
    url,
    pattern: "/api/resend/:scopeSegment/*",
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
    params: { scopeSegment, "*": input.suffix.slice(1) },
  };
  return input.method === "GET" ? await loader(args) : await action(args);
}

test.each(webhookCases)(
  "Resend $scopePathSegment webhooks use provider signatures without exposing management routes",
  async ({ scope, scopePathSegment }) => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `Resend ${scopePathSegment} public webhook boundary`,
        options: { drain: false },
        objectFactories: {
          RESEND: ({ state, env, runtime, implementation, nowEpochMs }) =>
            new InMemoryResendObject({
              state,
              env,
              runtime,
              implementation,
              nowEpochMs,
              createClient: () =>
                ({
                  webhooks: {
                    async create() {
                      return {
                        data: { id: "webhook-1", signing_secret: webhookSecret },
                        error: null,
                      };
                    },
                  },
                }) as never,
            }),
        },
        steps: ({ then }) => [
          then.assert("only a valid webhook reaches the durable queue", async (ctx) => {
            const resend = ctx.runtime.objects.resend.for(scope);
            const configured = await resend.commands.setAdminConfig(
              {
                apiKey: "re_test",
                defaultFrom: "Fragno <hello@example.com>",
                webhookBaseUrl: origin,
              },
              scope,
              origin,
            );
            expect(configured).toMatchObject({ configured: true, webhook: { ok: true } });

            const event = {
              type: "email.delivered",
              created_at: new Date().toISOString(),
              data: {
                email_id: "email-1",
                from: "hello@example.com",
                to: ["recipient@example.com"],
                subject: "Delivery notification",
                created_at: new Date().toISOString(),
              },
            };
            // Sign the original whitespace too, so parsing/re-encoding in the proxy would fail.
            const body = JSON.stringify(event, null, 2);
            const id = "msg_resend_webhook_1";
            const timestamp = String(Math.floor(Date.now() / 1_000));
            const signature = createHmac("sha256", signingKey)
              .update(`${id}.${timestamp}.${body}`)
              .digest("base64");
            const headers = {
              "content-type": "application/json",
              "svix-id": id,
              "svix-timestamp": timestamp,
              "svix-signature": `v1,${signature}`,
            };

            const unsigned = await callPublicResend(ctx, {
              scope,
              scopePathSegment,
              method: "POST",
              suffix: "/webhook",
              headers: { "content-type": "application/json" },
              body,
            });
            assert.equal(unsigned.status, 400);
            expect(await unsigned.json()).toMatchObject({ code: "MISSING_SIGNATURE" });

            const tampered = await callPublicResend(ctx, {
              scope,
              scopePathSegment,
              method: "POST",
              suffix: "/webhook",
              headers,
              body: body.replace("email-1", "email-forged"),
            });
            assert.equal(tampered.status, 400);
            expect(await tampered.json()).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });

            for (const input of [
              { method: "GET", suffix: "/webhook" },
              { method: "POST", suffix: "/webhook/extra" },
              { method: "POST", suffix: "/webhook/" },
              { method: "POST", suffix: "/%77ebhook" },
              { method: "POST", suffix: "/webhook%2Fextra" },
              { method: "GET", suffix: "/emails" },
              { method: "POST", suffix: "/emails" },
            ] as const) {
              const denied = await callPublicResend(ctx, {
                ...input,
                scope,
                scopePathSegment,
                headers,
                body,
              });
              assert.equal(denied.status, 401);
            }
            const before = await resend.commands.getDurableHookQueue();
            expect(before.items.filter((hook) => hook.hookName === "onResendWebhook")).toEqual([]);

            const accepted = await callPublicResend(ctx, {
              scope,
              scopePathSegment,
              method: "POST",
              suffix: "/webhook",
              headers,
              body,
            });
            assert.equal(accepted.status, 200, await accepted.clone().text());
            expect(await accepted.json()).toEqual({ success: true });
            const after = await resend.commands.getDurableHookQueue();
            expect(after.items.filter((hook) => hook.hookName === "onResendWebhook")).toMatchObject(
              [{ payload: { event } }],
            );
          }),
        ],
      }),
    );
  },
);
