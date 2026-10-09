import { assert, expect, test, vi } from "vitest";

import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { runProjectConnectorScenario } from "@/fragno/runtime-tools/families/project-connector-scenario.test-utils";
import { loader as callbackLoader } from "@/routes/api/project-connector";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import ProjectConnectorReturn, { loader } from "./project-connector-return";

const scenarioObjects = {
  API: (input) => new InMemoryApiObject(input),
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

test.each(["org:ada-labs", "project:ada-labs:project-1"])(
  "rejects a non-user Connector return for %s",
  (scopeSegment) => {
    try {
      loader({ params: { scopeSegment } } as Parameters<typeof loader>[0]);
      assert.fail("Expected the loader to reject a non-user scope");
    } catch (cause) {
      assert(cause instanceof Response);
      assert(cause.status === 404);
    }
  },
);

test.each([
  {
    scopeSegment: "user:user-1",
    backPath: "/backoffice/automations/user/user-1",
    label: "Personal account",
  },
])(
  "anonymous $scopeSegment returns render next steps without trusting provider claims",
  async ({ scopeSegment, backPath, label }) => {
    await runProjectConnectorScenario((gateway) => ({
      objects: scenarioObjects,
      name: `Connector public landing for ${scopeSegment}`,
      env: { OOMOL_PROJECT_API_KEY: undefined },
      setup: ({ given }) => [
        given.organization.exists({ id: "org-1", slug: "ada-labs", name: "Ada Labs" }),
      ],
      steps: ({ then }) => [
        then.assert(
          "the callback and page remain available without a session or connector credentials",
          async (ctx) => {
            const workerContext = {
              runtime: ctx.runtime.services,
              kernel: new BackofficeKernel(ctx.runtime.services),
              env: ctx.runtime.env as unknown as CloudflareEnv,
              ctx: {} as ExecutionContext,
            };
            const callbackUrl = new URL(
              `https://backoffice.example/api/connector/${encodeURIComponent(scopeSegment)}/oauth/callback?status=success&connected_account_id=forged-account&error_message=untrusted-provider-message&returnUri=https://attacker.example`,
            );
            const callbackRequest = new Request(callbackUrl, {
              headers: { authorization: "Bearer expired-invalid-token" },
            });
            const callback = await callbackLoader({
              request: callbackRequest,
              url: callbackUrl,
              pattern: "/api/connector/:scopeSegment/*",
              params: { scopeSegment, "*": "oauth/callback" },
              context: createBackofficeRouterContextProvider(callbackRequest, workerContext),
            });
            assert(callback.status === 302);
            const location = callback.headers.get("location");
            assert(location);
            expect(location).toBe(
              `https://backoffice.example/backoffice/connections/connector/return/${encodeURIComponent(scopeSegment)}`,
            );
            const handler = createStaticHandler([
              {
                id: "project-connector-return",
                path: "/backoffice/connections/connector/return/:scopeSegment",
                loader: (args) =>
                  loader({
                    ...args,
                    params: { scopeSegment: args.params.scopeSegment! },
                  }),
                Component: ProjectConnectorReturn,
              },
            ]);
            const pageUrl = new URL(location);
            pageUrl.searchParams.set("status", "success");
            pageUrl.searchParams.set("connected_account_id", "forged-account");
            pageUrl.searchParams.set("error_message", "untrusted-provider-message");
            pageUrl.searchParams.set("returnUri", "https://attacker.example");
            const request = new Request(pageUrl);
            const result = await handler.query(request, {
              requestContext: createBackofficeRouterContextProvider(request, workerContext),
            });
            assert(!(result instanceof Response));
            assert(result.statusCode === 200);
            const html = renderToString(
              <StaticRouterProvider
                router={createStaticRouter(handler.dataRoutes, result)}
                context={result}
                hydrate={false}
              />,
            );
            expect(html).toContain("You’re back in Backoffice.");
            expect(html).toContain("This page does not confirm");
            expect(html).toContain("Finish in your original tab");
            expect(html).toContain(
              "connector.connections.refresh --request-id REQUEST_ID --format json",
            );
            expect(html).toContain(`href="${backPath}"`);
            expect(html).toContain(label);
            expect(html).not.toContain("forged-account");
            expect(html).not.toContain("untrusted-provider-message");
            expect(html).not.toContain("attacker.example");
            expect(gateway.links).toEqual([]);
            expect(gateway.executions).toEqual([]);
            assert(gateway.control.requestReads === 0);
            const postRequest = new Request(location, {
              method: "POST",
              body: "connected_account_id=forged-account",
            });
            const posted = await handler.query(postRequest, {
              requestContext: createBackofficeRouterContextProvider(postRequest, workerContext),
            });
            assert(!(posted instanceof Response));
            assert(posted.statusCode === 405);
            assert(gateway.control.requestReads === 0);
          },
        ),
      ],
    }));
  },
);
