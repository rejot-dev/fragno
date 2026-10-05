import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeSystemExecution } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { apiPublicRoute } from "@/routes/api/api-route.server";
import { mcpPublicRoute } from "@/routes/api/mcp-route.server";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { forwardPublicFragmentRequest } from "./public-fragment-route.server";

const origin = "https://backoffice.example";
const orgId = "public-route-org";
const orgSlug = "public-workspace";
const scopePathSegment = `org:${orgSlug}`;
const scopeSpellings = [
  scopePathSegment,
  `org%3A${orgSlug}`,
  `org%3a${orgSlug}`,
  "org:%70ublic-workspace",
];

function publicFragmentScenarioContext(ctx: BackofficeScenarioContext, request: Request) {
  return createBackofficeRouterContextProvider(request, {
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel(ctx.runtime.services),
    env: ctx.runtime.env as unknown as CloudflareEnv,
    ctx: {} as ExecutionContext,
  });
}

test.each([
  { name: "API", route: apiPublicRoute, managementPath: "/connections" },
  { name: "MCP", route: mcpPublicRoute, managementPath: "/servers" },
])(
  "$name scope URL spellings preserve exact public OAuth callback boundaries",
  async ({ name, route, managementPath }) => {
    await runBackofficeScenario(
      defineBackofficeScenario({
        name: `${name} callback scope encoding`,
        options: { drain: false },
        setup: ({ given }) => [given.organization.exists({ id: orgId, slug: orgSlug })],
        steps: ({ then }) => [
          then.assert(
            "callbacks reach state validation while other paths require authentication",
            async (ctx) => {
              for (const spelling of scopeSpellings) {
                const request = new Request(
                  `${origin}${route.publicPrefix}/${spelling}/oauth/callback`,
                );
                const response = await forwardPublicFragmentRequest({
                  request,
                  context: publicFragmentScenarioContext(ctx, request),
                  scopePathSegment,
                  route,
                });
                // The real fragment rejects missing OAuth state rather than trusting the public URL.
                assert.equal(response.status, 302);
                const location = response.headers.get("location");
                assert(location);
                const redirect = new URL(location);
                assert.equal(
                  redirect.pathname,
                  `/backoffice/automations/org/${orgSlug}/${name.toLowerCase()}`,
                );
                assert.equal(redirect.searchParams.get("oauth"), "error");

                for (const { method, suffix } of [
                  { method: "POST", suffix: "/oauth/callback" },
                  { method: "GET", suffix: "/oauth/callback/extra" },
                  { method: "GET", suffix: "/oauth/callback/" },
                  { method: "GET", suffix: "/%6fauth/callback" },
                  { method: "GET", suffix: "/oauth%2Fcallback" },
                  { method: "GET", suffix: managementPath },
                ]) {
                  const protectedRequest = new Request(
                    `${origin}${route.publicPrefix}/${spelling}${suffix}`,
                    { method },
                  );
                  const denied = await forwardPublicFragmentRequest({
                    request: protectedRequest,
                    context: publicFragmentScenarioContext(ctx, protectedRequest),
                    scopePathSegment,
                    route,
                  });
                  assert.equal(denied.status, 401);
                }
              }

              for (const segment of [
                "org:another-workspace",
                "org%253Apublic-workspace",
                "org%ZZpublic-workspace",
              ]) {
                const request = new Request(
                  `${origin}${route.publicPrefix}/${segment}/oauth/callback`,
                );
                const rejected = await forwardPublicFragmentRequest({
                  request,
                  context: publicFragmentScenarioContext(ctx, request),
                  scopePathSegment,
                  route,
                });
                assert.equal(rejected.status, 404);
              }
            },
          ),
        ],
      }),
    );
  },
);

test("public API webhook scope aliases deliver to the same SQLite-backed endpoint", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "API webhook scope URL encoding",
      options: { drain: false },
      setup: ({ given }) => [given.organization.exists({ id: orgId, slug: orgSlug })],
      steps: ({ then }) => [
        then.assert(
          "both URL spellings persist deliveries without exposing endpoint management",
          async (ctx) => {
            const api = ctx.runtime.objects.api.forOrg(orgId);
            const configured = await api.http.fetchAuthorized(
              new Request(`${origin}/api/api/webhooks/endpoints/encoding-check`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  name: "Encoding checks",
                  status: "active",
                  auth: { type: "none" },
                  verification: { type: "none" },
                  deliveryIdentity: { type: "jsonBodyPath", path: ["id"] },
                }),
              }),
              { execution: createBackofficeSystemExecution({ kind: "org", orgId }) },
            );
            assert.equal(configured.status, 201, await configured.clone().text());

            for (const [index, spelling] of scopeSpellings.entries()) {
              const deliveryId = `encoding-delivery-${index}`;
              const request = new Request(
                `${origin}/api/http/${spelling}/webhooks/endpoints/encoding-check/events`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: deliveryId, message: "delivered" }),
                },
              );
              const accepted = await forwardPublicFragmentRequest({
                request,
                context: publicFragmentScenarioContext(ctx, request),
                scopePathSegment,
                route: apiPublicRoute,
              });
              assert.equal(accepted.status, 202, await accepted.clone().text());
              expect(await accepted.json()).toEqual({ accepted: true });

              const managementRequest = new Request(
                `${origin}/api/http/${spelling}/webhooks/endpoints/encoding-check`,
              );
              const denied = await forwardPublicFragmentRequest({
                request: managementRequest,
                context: publicFragmentScenarioContext(ctx, managementRequest),
                scopePathSegment,
                route: apiPublicRoute,
              });
              assert.equal(denied.status, 401);
            }

            const queue = await api.commands.getDurableHookQueue();
            expect(queue.items.filter((hook) => hook.hookName === "onWebhookReceived")).toEqual(
              expect.arrayContaining(
                scopeSpellings.map((_, index) =>
                  expect.objectContaining({
                    payload: expect.objectContaining({
                      endpointId: "encoding-check",
                      deliveryId: `encoding-delivery-${index}`,
                    }),
                  }),
                ),
              ),
            );
            assert.equal(
              queue.items.filter((hook) => hook.hookName === "onWebhookReceived").length,
              scopeSpellings.length,
            );
          },
        ),
      ],
    }),
  );
});
