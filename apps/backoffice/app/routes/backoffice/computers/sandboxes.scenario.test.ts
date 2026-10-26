import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import type { SandboxContainerControl } from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";

import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { behindBackofficeLayout } from "@/layouts/backoffice-layout.test-support";
import { CLOUDFLARE_SANDBOX_PROVIDER, type SandboxRuntimeProviders } from "@/sandbox/contracts";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

import { ApiObject } from "../../../../workers/api-object";
import { AuthObject } from "../../../../workers/auth-object";
import { AutomationsObject } from "../../../../workers/automations-object";
import { FormsObject } from "../../../../workers/forms-object";
import { OtpObject } from "../../../../workers/otp-object";
import { SandboxManagerObject } from "../../../../workers/sandbox-manager-object";
import { TelegramObject } from "../../../../workers/telegram-object";
import { UploadObject } from "../../../../workers/upload-object";
import { action as sandboxDetailAction } from "./sandbox-detail";
import { action as sandboxNewAction } from "./sandbox-new";
import { loader as sandboxesLoader } from "./sandboxes";

const sandboxAction = behindBackofficeLayout(sandboxDetailAction);
const createSandbox = behindBackofficeLayout(sandboxNewAction);
const listSandboxes = behindBackofficeLayout(sandboxesLoader);

const ORIGIN = "https://backoffice.example";

/** Containers that echo `printf` arguments, so command output is observable. */
function scenarioSandboxProviders(): SandboxRuntimeProviders {
  return {
    [CLOUDFLARE_SANDBOX_PROVIDER]: {
      provider: CLOUDFLARE_SANDBOX_PROVIDER,
      async getHandle(): Promise<SandboxContainerControl> {
        return {
          start: async () => ({ restoredSnapshot: null }),
          exec: async ({ argv }) => ({
            status: "exited",
            exitCode: 0,
            stdout: /^printf (\w+)$/.exec(argv.at(-1) ?? "")?.[1] ?? "",
            stderr: "",
          }),
          snapshot: async () => ({ status: "saved", snapshot: { id: "snapshot-1", size: 1024 } }),
          stop: async () => {},
        };
      },
    },
  };
}

const scenarioObjects = {
  MCP: null,
  OTP: (input) => new OtpObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  API: (input) => new ApiObject(input),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  UPLOAD: (input) => new UploadObject(input),
  FORMS: (input) => new FormsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  SANDBOX_MANAGER: (input) =>
    new SandboxManagerObject({
      ...input,
      sandboxProviders: input.createSandboxProviders(input.state.id.toString()),
    }),
} satisfies LocalBackofficeObjects;

type ComputersScenarioVars = { sessionCookie: string; orgId: string; cookie: string };

/** Builds the route arguments React Router passes for one signed-in browser request. */
function routeRequest<TParams extends { scopeKind: string; scopeId: string }>(
  ctx: BackofficeScenarioContext<ComputersScenarioVars>,
  path: string,
  params: TParams,
  form?: Record<string, string>,
) {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, {
    method: form ? "POST" : "GET",
    headers: { cookie: ctx.vars.cookie, origin: ORIGIN },
    body: form ? new URLSearchParams(form) : undefined,
  });
  return {
    request,
    url,
    pattern: path,
    params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
}

const ada = { scopeKind: "org", scopeId: "ada" };
const sandboxesUrl = "/backoffice/computers/org/ada/sandboxes";

async function rejection(promise: Promise<unknown>): Promise<Response> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  assert(thrown instanceof Response, `Expected a thrown Response, got ${String(thrown)}`);
  return thrown;
}

test("an organization member provisions, uses, and stops a sandbox from Computers", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "Computers sandbox lifecycle",
      createSandboxProviders: scenarioSandboxProviders,
      vars: () => ({ sessionCookie: "", orgId: "", cookie: "" }),
      setup: ({ given }) => [
        given.organization.exists({ id: "org-other", slug: "other", name: "Other team" }),
      ],
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@example.test", captureSessionCookieAs: "sessionCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.sessionCookie,
          name: "Ada",
          slug: "ada",
          captureOrganizationIdAs: "orgId",
        }),
        then.assert("sign in to Backoffice for Ada", async (ctx) => {
          const exchange = await ctx.runtime.objects.auth.singleton().http.fetch(
            new Request(`${ORIGIN}/api/auth/backoffice-token`, {
              method: "POST",
              headers: {
                cookie: ctx.vars.sessionCookie,
                origin: ORIGIN,
                "content-type": "application/json",
              },
              body: JSON.stringify({ selection: "required", organizationId: ctx.vars.orgId }),
            }),
          );
          assert(exchange.ok, await exchange.clone().text());
          ctx.vars.cookie = exchange.headers
            .getSetCookie()
            .map((header) => header.split(";", 1)[0])
            .join("; ");
        }),
        then.assert("Ada's computers start with no sandboxes", async (ctx) => {
          expect(await listSandboxes(routeRequest(ctx, sandboxesUrl, ada))).toEqual({
            status: "success",
            sandboxes: [],
          });
        }),
        then.assert("an image outside the list is refused without provisioning", async (ctx) => {
          expect(
            await createSandbox(
              routeRequest(ctx, `${sandboxesUrl}/new`, ada, {
                id: "build-box",
                image: "windows",
                instanceType: "lite",
                sleepAfter: "15m",
              }),
            ),
          ).toMatchObject({
            ok: false,
            message: "Choose an image and instance type from the list.",
          });
          expect(await listSandboxes(routeRequest(ctx, sandboxesUrl, ada))).toMatchObject({
            sandboxes: [],
          });
        }),
        then.assert("creating a sandbox opens its own page", async (ctx) => {
          const response = await createSandbox(
            routeRequest(ctx, `${sandboxesUrl}/new`, ada, {
              id: "build-box",
              image: "debian",
              instanceType: "standard-1",
              sleepAfter: "900",
              startupCommand: "true",
              startupTimeoutSeconds: "15",
            }),
          );
          assert(response instanceof Response);
          expect(response.headers.get("location")).toBe(`${sandboxesUrl}/build-box`);
        }),
        then.assert("the started sandbox runs commands from its page", async (ctx) => {
          await ctx.drain();
          expect(await listSandboxes(routeRequest(ctx, sandboxesUrl, ada))).toEqual({
            status: "success",
            sandboxes: [
              {
                id: "build-box",
                status: "running",
                image: "debian",
                instanceType: "standard-1",
                workspaceSaved: false,
                keepAlive: false,
                sleepAfter: 900,
                startupCommand: "true",
                startedAt: expect.any(Date),
                expectedStopAt: expect.any(Date),
                stoppedAt: null,
                lastError: null,
              },
            ],
          });
          expect(
            await sandboxAction(
              routeRequest(
                ctx,
                `${sandboxesUrl}/build-box`,
                { ...ada, sandboxId: "build-box" },
                { intent: "exec", command: "printf hello", timeoutSeconds: "30" },
              ),
            ),
          ).toEqual({
            intent: "exec",
            command: "printf hello",
            timeoutMs: 30_000,
            result: { ok: true, stdout: "hello", stderr: "", exitCode: 0 },
          });
        }),
        then.assert("stopping keeps the page and saves the workspace", async (ctx) => {
          const response = await sandboxAction(
            routeRequest(
              ctx,
              `${sandboxesUrl}/build-box`,
              { ...ada, sandboxId: "build-box" },
              { intent: "kill" },
            ),
          );
          assert(response instanceof Response);
          expect(response.headers.get("location")).toBe(`${sandboxesUrl}/build-box`);
          await ctx.drain();
          expect(await listSandboxes(routeRequest(ctx, sandboxesUrl, ada))).toMatchObject({
            sandboxes: [
              {
                id: "build-box",
                status: "stopped",
                workspaceSaved: true,
                stoppedAt: expect.any(Date),
              },
            ],
          });
        }),
        then.assert("resuming starts the sandbox again with its own settings", async (ctx) => {
          // The fields the page submits for a stopped sandbox.
          const response = await sandboxAction(
            routeRequest(
              ctx,
              `${sandboxesUrl}/build-box`,
              { ...ada, sandboxId: "build-box" },
              {
                intent: "resume",
                id: "build-box",
                image: "debian",
                instanceType: "standard-1",
                sleepAfter: "900",
                startupCommand: "true",
              },
            ),
          );
          assert(response instanceof Response);
          expect(response.headers.get("location")).toBe(`${sandboxesUrl}/build-box`);
          await ctx.drain();
          expect(await listSandboxes(routeRequest(ctx, sandboxesUrl, ada))).toMatchObject({
            sandboxes: [{ id: "build-box", status: "running", sleepAfter: 900, image: "debian" }],
          });
        }),
        then.assert("another organization's computers stay hidden", async (ctx) => {
          const other = { scopeKind: "org", scopeId: "other" };
          const response = await rejection(
            listSandboxes(routeRequest(ctx, "/backoffice/computers/org/other/sandboxes", other)),
          );
          assert(response.status === 404);
        }),
      ],
    }),
  );
});
