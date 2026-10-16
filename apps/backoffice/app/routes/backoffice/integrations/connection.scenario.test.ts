import { assert, expect, test, vi } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

// Observes configuration loads so the scenario can count them per request.
vi.mock("@/routes/backoffice/connections/telegram/data", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/routes/backoffice/connections/telegram/data")>();
  return { ...actual, fetchTelegramConfig: vi.fn(actual.fetchTelegramConfig) };
});
vi.mock("@/routes/backoffice/connections/resend/data", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/routes/backoffice/connections/resend/data")>();
  return { ...actual, fetchResendConfig: vi.fn(actual.fetchResendConfig) };
});
vi.mock("@/routes/backoffice/connections/upload/data", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/routes/backoffice/connections/upload/data")>();
  return { ...actual, fetchUploadConfig: vi.fn(actual.fetchUploadConfig) };
});

import { allLocalObjects } from "@/backoffice-runtime/all-local-objects";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
} from "@/fragno/automation/scenario";
import { establishBackofficeAuthenticatedRequest } from "@/layouts/backoffice-authenticated-request.server";
import {
  archiveAutomationProject,
  createAutomationProject,
  sessionUserId,
  withBackofficeAccessToken,
} from "@/layouts/backoffice-layout.test-support";
import { establishBackofficeShellRequest } from "@/layouts/backoffice-shell-request.server";
import { fetchResendConfig } from "@/routes/backoffice/connections/resend/data";
import { loader as resendLayoutLoader } from "@/routes/backoffice/connections/resend/organization-layout";
import {
  loader as resendThreadsLoader,
  middleware as resendThreadsMiddleware,
} from "@/routes/backoffice/connections/resend/threads";
import { loader as resendThreadsIndexLoader } from "@/routes/backoffice/connections/resend/threads-index";
import { fetchTelegramConfig } from "@/routes/backoffice/connections/telegram/data";
import {
  loader as telegramMessagesLoader,
  middleware as telegramMessagesMiddleware,
} from "@/routes/backoffice/connections/telegram/messages";
import { loader as telegramIndexLoader } from "@/routes/backoffice/connections/telegram/organization-index";
import { loader as telegramLayoutLoader } from "@/routes/backoffice/connections/telegram/organization-layout";
import { fetchUploadConfig } from "@/routes/backoffice/connections/upload/data";
import {
  loader as uploadFilesLoader,
  middleware as uploadFilesMiddleware,
} from "@/routes/backoffice/connections/upload/files";
import { loader as uploadLayoutLoader } from "@/routes/backoffice/connections/upload/organization-layout";
import { createBackofficeRouterContextProvider } from "@/worker-runtime/router-context-provider.server";

const origin = "https://backoffice.example";

type Vars = {
  adaCookie: string;
  orgId: string;
  adaId: string;
  launch: { id: string; slug: string };
  archived: { id: string; slug: string };
};
type Ctx = BackofficeScenarioContext<Vars>;

type RouteMiddleware = (args: never, next: () => Promise<Response>) => unknown;
type RouteLoader = (args: never) => unknown;
/** A route React Router matches for a page: its middleware, and its loader if it has one. */
type MatchedRoute = { middleware: readonly RouteMiddleware[]; loader: RouteLoader | null };

const telegramLayout = { middleware: [], loader: telegramLayoutLoader } satisfies MatchedRoute;
const resendLayout = { middleware: [], loader: resendLayoutLoader } satisfies MatchedRoute;
const uploadLayout = { middleware: [], loader: uploadLayoutLoader } satisfies MatchedRoute;

/** Each page and the routes React Router matches for it, outermost first. */
const pages = {
  telegram: {
    leaf: "telegram",
    routes: [telegramLayout, { middleware: [], loader: telegramIndexLoader }],
  },
  "telegram messages": {
    leaf: "telegram/messages",
    // The messages index has no loader.
    routes: [
      telegramLayout,
      { middleware: telegramMessagesMiddleware, loader: telegramMessagesLoader },
    ],
  },
  // Configuration has no loader.
  "telegram configuration": { leaf: "telegram/configuration", routes: [telegramLayout] },
  "resend threads": {
    leaf: "resend/threads",
    routes: [
      resendLayout,
      { middleware: resendThreadsMiddleware, loader: resendThreadsLoader },
      { middleware: [], loader: resendThreadsIndexLoader },
    ],
  },
} satisfies Record<string, { leaf: string; routes: MatchedRoute[] }>;

const uploadFilesPage = [
  uploadLayout,
  // The files index has no loader.
  { middleware: uploadFilesMiddleware, loader: uploadFilesLoader },
] satisfies MatchedRoute[];

function configurationLoads() {
  return [fetchTelegramConfig, fetchResendConfig, fetchUploadConfig].reduce(
    (count, fetchConfig) => count + vi.mocked(fetchConfig).mock.calls.length,
    0,
  );
}

function redirectLocation(value: unknown) {
  return value instanceof Response && value.status >= 300 && value.status < 400
    ? value.headers.get("location")
    : null;
}

/**
 * Opens a page the way React Router does on the server: the Backoffice middlewares, then each
 * matched route's middleware, then the matched loaders in parallel within one request. A redirect
 * from any loader wins. A response thrown before the loaders replaces the whole Backoffice layout;
 * one thrown by a loader renders inside the shell.
 */
async function openPage(
  ctx: Ctx,
  input: {
    pathname: string;
    params: Record<string, string>;
    routes: readonly MatchedRoute[];
  },
) {
  const url = new URL(`${origin}${input.pathname}`);
  const request = new Request(url, { headers: { cookie: ctx.vars.adaCookie } });
  const args = {
    request,
    url,
    params: input.params,
    context: createBackofficeRouterContextProvider(request, {
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      env: ctx.runtime.env as unknown as CloudflareEnv,
      ctx: {} as ExecutionContext,
    }),
  };
  const middleware = input.routes.flatMap((route) => route.middleware);
  const loadsBefore = configurationLoads();
  let loaded: PromiseSettledResult<unknown>[] = [];
  const runRouteMiddleware = async (index: number): Promise<Response> => {
    const current = middleware[index];
    if (!current) {
      loaded = await Promise.allSettled(
        input.routes.map(async (route) => await route.loader?.(args as never)),
      );
      return new Response(null);
    }
    const response = await current(args as never, () => runRouteMiddleware(index + 1));
    return response instanceof Response ? response : new Response(null);
  };
  try {
    await establishBackofficeAuthenticatedRequest(args, () =>
      establishBackofficeShellRequest(args, () => runRouteMiddleware(0)),
    );
  } catch (error) {
    assert(error instanceof Response, String(error));
    const location = redirectLocation(error);
    const loads = configurationLoads() - loadsBefore;
    return location
      ? ({ redirectsTo: location, from: "middleware", configurationLoads: loads } as const)
      : ({ renders: "without-shell", status: error.status, configurationLoads: loads } as const);
  }
  const loads = configurationLoads() - loadsBefore;
  for (const result of loaded) {
    const location = redirectLocation(result.status === "fulfilled" ? result.value : result.reason);
    if (location) {
      return { redirectsTo: location, from: "loader", configurationLoads: loads } as const;
    }
  }
  const failure = loaded.find((result) => result.status === "rejected");
  if (failure) {
    assert(failure.reason instanceof Response, String(failure.reason));
    return {
      renders: "in-section",
      status: failure.reason.status,
      configurationLoads: loads,
    } as const;
  }
  const [layout, ...children] = loaded.map((result) => {
    assert(result.status === "fulfilled");
    return result.value;
  });
  return { renders: "page", layout, leaf: children.at(-1), configurationLoads: loads } as const;
}

function openIntegrationPage(
  ctx: Ctx,
  pageName: keyof typeof pages,
  scope: { kind: string; id: string },
) {
  const page = pages[pageName];
  return openPage(ctx, {
    pathname: `/backoffice/integrations/${scope.kind}/${encodeURIComponent(scope.id)}/${page.leaf}`,
    params: { scopeKind: scope.kind, scopeId: scope.id },
    routes: page.routes,
  });
}

function openUploadFiles(ctx: Ctx, orgSlug: string) {
  return openPage(ctx, {
    pathname: `/backoffice/connections/upload/${orgSlug}/files`,
    params: { orgSlug },
    routes: uploadFilesPage,
  });
}

const acme = { kind: "org", id: "acme" };

test("connection pages share one configuration load and open only once configured", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario<Vars>({
      name: "Backoffice connection routes",
      objects: allLocalObjects,
      env: { AUTH_EMAIL_VERIFICATION_ENABLED: "false" },
      fakes: ({ fake }) => ({ telegram: fake.telegram() }),
      vars: () => ({
        adaCookie: "",
        orgId: "",
        adaId: "",
        launch: { id: "", slug: "" },
        archived: { id: "", slug: "" },
      }),
      steps: ({ when, then }) => [
        when.auth.signUp({ email: "ada@acme.test", captureSessionCookieAs: "adaCookie" }),
        when.auth.createOrganization({
          cookie: ({ vars }) => vars.adaCookie,
          name: "Acme",
          slug: "acme",
          captureOrganizationIdAs: "orgId",
        }),
        then.assert("Ada works in Acme, with a project and an archived one", async (ctx) => {
          ctx.vars.adaId = await sessionUserId(ctx, ctx.vars.adaCookie);
          ctx.vars.adaCookie = await withBackofficeAccessToken(
            ctx,
            ctx.vars.adaCookie,
            ctx.vars.orgId,
          );
          const project = { orgId: ctx.vars.orgId, createdByUserId: ctx.vars.adaId };
          ctx.vars.launch = await createAutomationProject(ctx, { ...project, name: "Launch" });
          ctx.vars.archived = await createAutomationProject(ctx, { ...project, name: "Retired" });
          await archiveAutomationProject(ctx, {
            orgId: ctx.vars.orgId,
            projectId: ctx.vars.archived.id,
          });
        }),
        then.assert(
          "unconfigured connections send their pages to configuration before the pages load",
          async (ctx) => {
            expect(await openIntegrationPage(ctx, "telegram messages", acme)).toEqual({
              redirectsTo: "/backoffice/integrations/org/acme/telegram/configuration",
              from: "middleware",
              configurationLoads: 1,
            });
            expect(await openIntegrationPage(ctx, "resend threads", acme)).toEqual({
              redirectsTo: "/backoffice/integrations/org/acme/resend/configuration",
              from: "middleware",
              configurationLoads: 1,
            });
            // The layout and the index share the configuration they both read.
            expect(await openIntegrationPage(ctx, "telegram", acme)).toEqual({
              redirectsTo: "/backoffice/integrations/org/acme/telegram/configuration",
              from: "loader",
              configurationLoads: 1,
            });
          },
        ),
        then.assert("Ada connects Telegram for Acme", async (ctx) => {
          await ctx.runtime.objects.telegram.forOrg(ctx.vars.orgId).commands.setAdminConfig({
            orgId: ctx.vars.orgId,
            botToken: "123456:telegram-bot-token",
            webhookSecretToken: "telegram-webhook-secret",
            botUsername: "acme_bot",
            apiBaseUrl: "https://telegram.test",
          });
        }),
        then.assert(
          "a configured connection opens, its layout and pages sharing one configuration load",
          async (ctx) => {
            expect(await openIntegrationPage(ctx, "telegram messages", acme)).toMatchObject({
              renders: "page",
              layout: { label: "Acme", configState: { configured: true }, configError: null },
              leaf: { chats: [], chatsError: null, configError: null },
              configurationLoads: 1,
            });
            expect(await openIntegrationPage(ctx, "telegram", acme)).toEqual({
              redirectsTo: "/backoffice/integrations/org/acme/telegram/messages",
              from: "loader",
              configurationLoads: 1,
            });
            // Upload stores files in the database until an organization configures storage.
            expect(await openUploadFiles(ctx, "acme")).toMatchObject({
              renders: "page",
              layout: { organization: { slug: "acme" }, configState: { configured: true } },
              leaf: { configState: { defaultProvider: "database" }, selectedNodeKind: "root" },
              configurationLoads: 1,
            });
          },
        ),
        then.assert(
          "connection layouts name a project scope, and scopes without a connection are 404s inside the shell",
          async (ctx) => {
            const project = (slug: string) => ({ kind: "project", id: `org:acme:${slug}` });
            expect(
              await openIntegrationPage(
                ctx,
                "telegram configuration",
                project(ctx.vars.launch.slug),
              ),
            ).toMatchObject({
              renders: "page",
              layout: { label: "Launch", configState: { configured: false } },
              configurationLoads: 1,
            });
            expect(
              await openIntegrationPage(
                ctx,
                "telegram configuration",
                project(ctx.vars.archived.slug),
              ),
            ).toMatchObject({ renders: "in-section", status: 404 });
            // Resend has no connection in a user's own scope, so nothing loads its configuration.
            expect(
              await openIntegrationPage(ctx, "resend threads", {
                kind: "user",
                id: ctx.vars.adaId,
              }),
            ).toEqual({ renders: "in-section", status: 404, configurationLoads: 0 });
            expect(await openUploadFiles(ctx, "unknown-org")).toEqual({
              renders: "in-section",
              status: 404,
              configurationLoads: 0,
            });
          },
        ),
      ],
    }),
  );
});
