import { assert, expect, test, vi } from "vitest";

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { automationEventListResultSchema } from "@fragno-dev/backoffice-api/v0/events";
import { createRouteCaller } from "@fragno-dev/core/api";

import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  defineBackofficeScenario,
  runBackofficeScenario,
  type BackofficeScenarioContext,
  type BackofficeScenarioDefinitionInput,
} from "@/fragno/automation/scenario";
import type { GitHubFragment, GitHubInstallationOwner } from "@/fragno/github";
import {
  claimGitHubInstallation,
  completeGitHubInstallCallback,
  finishGitHubSignIn,
  releaseGitHubInstallation,
  type GitHubSignInOutcome,
} from "@/fragno/github-access";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { bytesToHex } from "@/lib/crypto";

import { ApiObject } from "../../../../../workers/api-object";
import { AppInstallationsObject } from "../../../../../workers/app-installations-object";
import { AppsObject } from "../../../../../workers/apps-object";
import { AuthObject } from "../../../../../workers/auth-object";
import { AutomationsObject } from "../../../../../workers/automations-object";
import { CodemodeObject } from "../../../../../workers/codemode-object";
import { FormsObject } from "../../../../../workers/forms-object";
import { GitHubObject } from "../../../../../workers/github-object";
import { GitHubWebhookRouterObject } from "../../../../../workers/github-webhook-router-object";
import { McpObject } from "../../../../../workers/mcp-object";
import { OtpObject } from "../../../../../workers/otp-object";
import { ProjectConnectorObject } from "../../../../../workers/project-connector-object";
import { ResendObject } from "../../../../../workers/resend-object";
import { TelegramObject } from "../../../../../workers/telegram-object";
import { UploadObject } from "../../../../../workers/upload-object";
const scenarioObjects = {
  API: (input) => new ApiObject(input),
  APPS: (input) => new AppsObject(input),
  APP_INSTALLATIONS: (input) => new AppInstallationsObject(input),
  AUTH: (input) => new AuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new AutomationsObject(input),
  CODEMODE: (input) => new CodemodeObject(input),
  FORMS: (input) => new FormsObject(input),
  MCP: (input) => new McpObject(input),
  PROJECT_CONNECTOR: (input) => new ProjectConnectorObject(input),
  RESEND: (input) => new ResendObject(input),
  TELEGRAM: (input) => new TelegramObject(input),
  UPLOAD: (input) => new UploadObject(input),
  GITHUB: (input) => new GitHubObject(input),
  GITHUB_WEBHOOK_ROUTER: (input) => new GitHubWebhookRouterObject(input),
  OTP: (input) => new OtpObject(input),
} satisfies LocalBackofficeObjects;

const scope = { kind: "org", orgId: "github-org", jurisdiction: null } as const;
const ownerUserId = "github-owner";
const personalScope = { kind: "user", userId: ownerUserId, jurisdiction: null } as const;
const installationId = "4242";
const webhookSecret = "github-integration-webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

type GitHubRepositoryFixture = { id: number; name: string; full_name: string; private: boolean };

/** GitHub's view of the installation: what the user selected on github.com. */
type FakeGitHub = {
  repositories: GitHubRepositoryFixture[];
  /** A suspended installation issues no tokens; webhooks only announce the change. */
  suspended: boolean;
  requests: string[];
  /** Restrictions requested for each installation token, in order. */
  tokenRequests: unknown[];
  /** The app's installations the user who signs in to GitHub can access. */
  userInstallations: (typeof acmeInstallation)[];
  /** Runs as the app reads the installation, before GitHub answers; it can hold the answer. */
  onInstallationRead?: () => Promise<void>;
};

const project = { id: 101, name: "project", full_name: "acme/project", private: false };
const web = { id: 102, name: "web", full_name: "acme/web", private: true };
const githubAccount = { login: "acme", id: 77, type: "Organization" };
/** The app's installation on acme, as GitHub lists it to a user who can access it. */
const acmeInstallation = {
  id: Number(installationId),
  app_id: 1,
  app_slug: "in-memory-github-app",
  account: githubAccount,
  repository_selection: "selected",
  permissions: { pull_requests: "read" },
  events: ["pull_request"],
  html_url: `https://github.com/organizations/acme/settings/installations/${installationId}`,
};
const pullRequestOpened = {
  action: "opened",
  installation: { id: Number(installationId) },
  repository: { ...project, owner: { login: "acme", id: 77 } },
  pull_request: { id: 1, number: 7, title: "Add webhook support", state: "open" },
  sender: { login: "octo-dev", id: 10 },
};

async function runGitHubIntegrationScenario<TVars extends Record<string, unknown>>(
  defineScenario: (github: FakeGitHub) => Omit<BackofficeScenarioDefinitionInput<TVars>, "objects">,
) {
  const github: FakeGitHub = {
    repositories: [project],
    suspended: false,
    requests: [],
    tokenRequests: [],
    userInstallations: [],
  };
  const githubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      return Response.json({ access_token: "user-token", token_type: "bearer", scope: "" });
    }
    assert(url.origin === "https://api.github.com", `Unexpected GitHub request to ${url.origin}`);
    if (request.headers.get("authorization") === "token user-token") {
      if (url.pathname === "/user") {
        return Response.json({ id: 10, login: "octo-dev" });
      }
      if (url.pathname === "/user/installations") {
        return Response.json({
          total_count: github.userInstallations.length,
          installations: github.userInstallations,
        });
      }
    }
    github.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname === `/app/installations/${installationId}`) {
      await github.onInstallationRead?.();
      return Response.json({
        id: Number(installationId),
        account: githubAccount,
        suspended_at: github.suspended ? "2024-01-01T00:00:00Z" : null,
        permissions: { pull_requests: "read" },
        events: ["pull_request"],
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === `/app/installations/${installationId}/access_tokens`
    ) {
      if (github.suspended) {
        return Response.json({ message: "This installation has been suspended" }, { status: 403 });
      }
      const text = await request.text();
      const restriction = text ? JSON.parse(text) : null;
      github.tokenRequests.push(restriction);
      // Tokens restricted to repositories are distinguishable from the installation-wide token.
      const token = restriction?.repository_ids
        ? `repository-token-${restriction.repository_ids.join(",")}`
        : "installation-token";
      return Response.json(
        { token, expires_at: "2099-01-01T00:00:00Z", repository_selection: "selected" },
        { status: 201 },
      );
    }
    if (url.pathname.startsWith("/repos/acme/project/issues")) {
      assert(
        request.headers.get("authorization") === "token repository-token-101",
        "Proxied requests use a token restricted to the connected repository",
      );
      return request.method === "GET"
        ? Response.json([{ number: 3, title: "Bug" }], {
            headers: {
              link: '<https://api.github.com/repos/acme/project/issues?page=2>; rel="next"',
            },
          })
        : Response.json({ message: "Validation Failed" }, { status: 422 });
    }
    assert(
      request.headers.get("authorization") === "token installation-token",
      "Repository reads require the installation token",
    );
    if (request.method === "GET" && url.pathname === "/installation/repositories") {
      return Response.json({
        total_count: github.repositories.length,
        repositories: github.repositories.map((repository) => ({
          ...repository,
          owner: { login: "acme" },
        })),
      });
    }
    if (request.method === "GET" && url.pathname === "/repos/acme/project/pulls") {
      return Response.json([{ number: 7, title: "Add webhook support", state: "open" }]);
    }
    throw new Error(`Unexpected GitHub request ${request.method} ${url.pathname}`);
  };
  const directory = await mkdtemp(path.join(tmpdir(), "backoffice-github-integration-"));
  try {
    const scenario = defineScenario(github);
    await runBackofficeScenario(
      defineBackofficeScenario({
        ...scenario,
        env: {
          ...scenario.env,
          GITHUB_APP_PRIVATE_KEY: privateKeyPem,
          GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
        },
        options: { ...scenario.options, sqliteDataDirectory: directory },
        objects: {
          ...scenarioObjects,
          GITHUB: (options) =>
            new GitHubObject({ ...options, env: options.env as never, fetch: githubFetch }),
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createTerminal(
  ctx: BackofficeScenarioContext,
  execution: BackofficeExecutionContext,
) {
  const runtime: BackofficeRuntimeServices = ctx.runtime.services;
  const context = createRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime,
    execution,
    kernel: new BackofficeKernel(runtime),
  });
  assert(context.stateBackend);
  const { bash } = await createInteractiveBashHost({
    context: { ...context, stateBackend: context.stateBackend },
  });
  return {
    async json(command: string) {
      const result = await bash.exec(`${command} --json`);
      expect(result.exitCode, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    },
    exec: (command: string) => bash.exec(command),
  };
}

function setup(connectionId: string, input: unknown = null) {
  return input === null
    ? `integrations.setup --connection-id '${connectionId}'`
    : `integrations.setup --connection-id '${connectionId}' --input-json '${JSON.stringify(input)}'`;
}

/** Delivers a webhook the way GitHub does: signed, through the router's installation mapping. */
async function deliverGitHubWebhook(
  ctx: BackofficeScenarioContext,
  event: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify(payload);
  const deliveryId = `delivery-${event}-${crypto.randomUUID()}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const response = await ctx.runtime.objects.githubWebhookRouter.singleton().http.fetch(
    new Request("https://backoffice.example/api/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${bytesToHex(new Uint8Array(signature))}`,
      },
      body,
    }),
  );
  expect(response.ok, await response.clone().text()).toBe(true);
  return deliveryId;
}

/** The GitHub object of a workspace and its routes, as the user returning from GitHub reaches them. */
function githubOf(ctx: BackofficeScenarioContext, owner: GitHubInstallationOwner) {
  const execution = createBackofficeUserExecution({ scope: owner, userId: ownerUserId });
  const kernel = new BackofficeKernel(ctx.runtime.services);
  const github = kernel.scoped("GITHUB", owner, ctx.runtime.objects.github);
  const transport = authorizedBackofficeObjectHttp(github.http, execution);
  return {
    router: ctx.runtime.objects.githubWebhookRouter.singleton().commands,
    github: github.commands,
    callRoute: createRouteCaller<GitHubFragment>({
      baseUrl: "https://github.do",
      mountRoute: "/api/github",
      fetch: async (request) => {
        await github.commands.ensureAdminConfig();
        return await transport.fetch(request);
      },
    }),
  };
}

/** The user signs in on GitHub, which returns them to the OAuth callback; it finishes as there. */
async function returnFromSignIn(
  ctx: BackofficeScenarioContext,
  owner: GitHubInstallationOwner,
  authorizationUrl: string,
): Promise<{ kind: "choose" } | GitHubSignInOutcome> {
  const url = new URL(authorizationUrl);
  assert(url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize");
  const state = url.searchParams.get("state");
  assert(state);
  const { router, github, callRoute } = githubOf(ctx, owner);
  const resolved = await router.resolveInstallationClaimState({ state, userId: ownerUserId });
  assert(resolved.ok, "The sign-in is bound to the user who started it");
  return await finishGitHubSignIn({
    router,
    github,
    callRoute,
    userId: ownerUserId,
    owner,
    purpose: resolved.purpose,
    state,
    code: "oauth-code",
  });
}

/**
 * GitHub returns from its install page to the setup callback with an installation id, which
 * Backoffice verifies with a sign-in it returns.
 */
async function returnFromInstall(
  ctx: BackofficeScenarioContext,
  owner: GitHubInstallationOwner,
  installUrl: string,
  returnedInstallationId = installationId,
) {
  const url = new URL(installUrl);
  assert(url.pathname === "/apps/in-memory-github-app/installations/new");
  const state = url.searchParams.get("state");
  assert(state);
  const { router, callRoute } = githubOf(ctx, owner);
  const outcome = await completeGitHubInstallCallback({
    router,
    callRoute,
    userId: ownerUserId,
    owner,
    state,
    installationId: returnedInstallationId,
    returnTo: "/backoffice/integrations/org/github-org/github/configuration",
  });
  if (typeof outcome === "string") {
    throw new Error(`The install callback failed: ${outcome}`);
  }
  return outcome.authorizationUrl;
}

const boundAcme = (linked: string[], missing: string[] = []) => ({
  kind: "bound",
  installation: {
    id: installationId,
    account: "acme",
    url: acmeInstallation.html_url,
  },
  synced: true,
  linked,
  missing,
});

test("a repository becomes a connection after the GitHub App is installed, linked, used, and unlinked", async () => {
  let pullRequestDeliveryId = "";
  await runGitHubIntegrationScenario((github) => ({
    name: "GitHub repository connections through the integrations facade",
    setup: ({ given }) => [
      given.auth.user({ id: ownerUserId, email: "owner@example.test" }),
      given.auth.organization({
        id: scope.orgId,
        slug: "github-org",
        name: "GitHub Org",
        ownerUserId,
      }),
    ],
    steps: ({ then, runner }) => [
      then.assert(
        "an unreachable repository asks a user for GitHub access and resumes the pending link",
        async (ctx) => {
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          const services = await system.json("integrations.discover");
          expect(services).toContainEqual(
            expect.objectContaining({
              id: "github",
              connectionCardinality: "multiple",
              availability: { status: "available" },
              setupTargets: [],
            }),
          );
          expect(await system.json(setup("github#acme/project"))).toMatchObject({
            status: "needs-input",
            connectionId: "github#acme/project",
            instructions: expect.stringContaining("not installed on acme"),
          });
          expect(await system.json(setup("github#acme/project", { link: true }))).toMatchObject({
            status: "blocked",
            reason: expect.stringContaining("signed-in user"),
          });
          const user = await createTerminal(
            ctx,
            createBackofficeUserExecution({ scope, userId: ownerUserId }),
          );
          expect(await user.json(setup("github#acme/project"))).toMatchObject({
            status: "needs-input",
          });
          const authorization = await user.json(setup("github#acme/project", { link: true }));
          expect(authorization).toMatchObject({
            status: "needs-authorization",
            connectionId: "github#acme/project",
          });
          // The pending link is resumed, not replaced, until GitHub's callback uses it.
          expect(await user.json(setup("github#acme/project"))).toEqual(authorization);
          expect(await user.json(setup("github#acme/project", { link: true }))).toEqual(
            authorization,
          );
          // A GitHub install covers one account, so another account gets its own link.
          const octoAuthorization = await user.json(setup("github#octo/tools", { link: true }));
          expect(octoAuthorization).toMatchObject({ status: "needs-authorization" });
          assert(octoAuthorization.authorizationUrl !== authorization.authorizationUrl);
          expect(await user.json(setup("github#acme/project"))).toEqual(authorization);
          // The link is a GitHub sign-in, which shows the installations the user reaches.
          const signInUrl = new URL(authorization.authorizationUrl);
          assert(signInUrl.origin === "https://github.com");
          assert(signInUrl.searchParams.get("client_id") === "in-memory-github-app-client-id");

          // The user reaches no installation on acme, so GitHub's install page is next.
          const signedIn = await returnFromSignIn(ctx, scope, authorization.authorizationUrl);
          assert(signedIn.kind === "install" && signedIn.account === "acme");
          // That sign-in is used up; setup offers the install it led to.
          expect(await user.json(setup("github#acme/project"))).toEqual({
            ...authorization,
            authorizationUrl: signedIn.installUrl,
          });

          // The user installs the app on acme; GitHub's redirect only claims the installation, so a
          // sign-in verifies the user reaches it before it is bound.
          github.userInstallations = [acmeInstallation];
          const verifying = await returnFromInstall(ctx, scope, signedIn.installUrl);
          const router = ctx.runtime.objects.githubWebhookRouter.singleton().commands;
          expect(await router.getInstallationOwner(installationId)).toBeNull();
          expect(await returnFromSignIn(ctx, scope, verifying)).toEqual(
            boundAcme(["acme/project"]),
          );
          expect(await router.getInstallationOwner(installationId)).toEqual(scope);
          expect(github.requests).toEqual(
            expect.arrayContaining([
              `GET /app/installations/${installationId}`,
              "GET /installation/repositories",
            ]),
          );
          // acme's install link was used; octo's sign-in is untouched.
          expect(await router.getPendingInstall(ownerUserId, scope, "acme")).toBeNull();
          expect(await user.json(setup("github#octo/tools"))).toEqual(octoAuthorization);
          // Installing on acme from octo's link binds acme, and says octo/tools is not reachable.
          const octoSignedIn = await returnFromSignIn(
            ctx,
            scope,
            octoAuthorization.authorizationUrl,
          );
          assert(octoSignedIn.kind === "install");
          const octoVerifying = await returnFromInstall(ctx, scope, octoSignedIn.installUrl);
          expect(await returnFromSignIn(ctx, scope, octoVerifying)).toEqual(
            boundAcme([], ["octo/tools"]),
          );
          expect(await user.json(setup("github#octo/tools"))).toMatchObject({
            status: "needs-input",
            connectionId: "github#octo/tools",
          });
        },
      ),
      then.assert(
        "returning from GitHub linked the requested repository, so setup is ready and it lists",
        async (ctx) => {
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect(await system.json(setup("github#acme/project"))).toEqual({
            status: "ready",
            connectionId: "github#acme/project",
          });
          expect(await system.json("integrations.list")).toEqual({
            connections: [
              expect.objectContaining({
                connectionId: "github#acme/project",
                integrationId: "github",
                name: "acme/project",
                configuration: { status: "configured" },
                authorization: { status: "available" },
              }),
            ],
            unavailableSources: [],
            cursor: null,
          });
        },
      ),
      runner.drain(),
      then.automation.event({
        scope,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "github", connectionId: "github#acme/project" } },
      }),
      then.assert(
        "a repository added on GitHub without a webhook is found by setup's refresh",
        async (ctx) => {
          github.repositories = [project, web];
          github.requests = [];
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect(await system.json(setup("github#acme/web"))).toMatchObject({
            status: "needs-input",
            instructions: expect.stringContaining("can reach acme/web"),
          });
          expect(await system.json(setup("github#acme/web", { link: true }))).toEqual({
            status: "ready",
            connectionId: "github#acme/web",
          });
          // The installation token from the callback's sync is still cached.
          expect(github.requests).toEqual([
            `GET /app/installations/${installationId}`,
            "GET /installation/repositories",
          ]);
          expect(
            (await system.json("integrations.list")).connections.map(
              (connection: { connectionId: string }) => connection.connectionId,
            ),
          ).toEqual(["github#acme/project", "github#acme/web"]);
        },
      ),
      then.assert("actions and verification read the repository through GitHub", async (ctx) => {
        const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
        const target = "--connection-id 'github#acme/project'";
        expect(await system.json(`integrations.actions ${target}`)).toMatchObject([
          { id: "pulls.list" },
          { id: "repository.access-token.create" },
          { id: "api.request" },
          { id: "delivery.get" },
        ]);
        github.tokenRequests = [];
        expect(
          await system.json(
            `integrations.execute ${target} --action-id repository.access-token.create --input-json '{}'`,
          ),
        ).toEqual({ token: "repository-token-101", expiresAt: "2099-01-01T00:00:00Z" });
        expect(github.tokenRequests).toEqual([
          { repository_ids: [101], permissions: { contents: "read" } },
        ]);
        const request = (input: Record<string, unknown>) =>
          `integrations.execute ${target} --action-id api.request --input-json '${JSON.stringify({ query: null, body: null, ...input })}'`;
        expect(
          await system.json(request({ method: "GET", path: "/issues", query: { state: "open" } })),
        ).toEqual({
          status: 200,
          headers: expect.objectContaining({ link: expect.stringContaining('rel="next"') }),
          body: [{ number: 3, title: "Bug" }],
        });
        expect(
          await system.json(request({ method: "POST", path: "/issues", body: { title: "" } })),
        ).toMatchObject({ status: 422, body: { message: "Validation Failed" } });
        expect(github.tokenRequests.at(-1)).toEqual({ repository_ids: [101] });
        const escaped = await system.exec(request({ method: "GET", path: "/../web" }));
        assert(escaped.exitCode === 1);
        expect(
          await system.json(
            `integrations.execute ${target} --action-id pulls.list --input-json '{"state":null,"perPage":null,"page":null}'`,
          ),
        ).toEqual({
          pulls: [{ number: 7, title: "Add webhook support", state: "open" }],
          pageInfo: { page: 1, perPage: 30 },
        });
        expect(await system.json(`integrations.verify ${target}`)).toMatchObject({
          connectionId: "github#acme/project",
          checks: [{ id: "pulls.read", status: "passed" }],
        });
        pullRequestDeliveryId = await deliverGitHubWebhook(ctx, "pull_request", pullRequestOpened);
      }),
      runner.drain(),
      then.automation.event({
        scope,
        where: { source: "github", eventType: "webhook.received" },
        expected: {
          subject: { connectionId: "github#acme/project", pullRequestNumber: "7" },
        },
      }),
      then.assert(
        "the stored event keeps the envelope; delivery.get reads the body",
        async (ctx) => {
          const response = await ctx.runtime.objects.automations
            .for(scope)
            .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
          const { events } = automationEventListResultSchema.parse(await response.json());
          const received = events.find(
            (event) =>
              event.source === "github" && event.payload.deliveryId === pullRequestDeliveryId,
          );
          expect(received?.payload).toEqual({
            deliveryId: pullRequestDeliveryId,
            githubEvent: "pull_request",
            action: "opened",
            installationId,
            issue: null,
            pullRequest: { number: 7, title: "Add webhook support" },
          });
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect(
            await system.json(
              `integrations.execute --connection-id 'github#acme/project' --action-id delivery.get --input-json '${JSON.stringify({ deliveryId: pullRequestDeliveryId })}'`,
            ),
          ).toMatchObject({
            deliveryId: pullRequestDeliveryId,
            event: "pull_request",
            action: "opened",
            payload: pullRequestOpened,
          });
        },
      ),
      then.assert("GitHub suspends the installation", async (ctx) => {
        github.suspended = true;
        await deliverGitHubWebhook(ctx, "installation", {
          action: "suspend",
          installation: { id: Number(installationId), account: githubAccount },
        });
      }),
      runner.drain(),
      then.automation.event({
        scope,
        where: { source: "integrations", eventType: "connection.unavailable" },
        expected: { subject: { service: "github", connectionId: "github#acme/web" } },
      }),
      then.assert("GitHub restores the installation", async (ctx) => {
        github.suspended = false;
        await deliverGitHubWebhook(ctx, "installation", {
          action: "unsuspend",
          installation: { id: Number(installationId), account: githubAccount },
        });
      }),
      runner.drain(),
      then.assert("restored repositories are available again", async (ctx) => {
        const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
        expect(
          await system.json(`integrations.get --connection-id 'github#acme/web'`),
        ).toMatchObject({ authorization: { status: "available" } });
      }),
      then.assert(
        "disconnecting unlinks the repository but leaves GitHub access in place",
        async (ctx) => {
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          const target = "github#acme/project";
          expect(
            await system.json(
              `integrations.disconnect --connection-id '${target}' --confirm '${target}'`,
            ),
          ).toEqual({ connectionId: target, status: "disconnected" });
          expect(
            await system.json(
              `integrations.disconnect --connection-id '${target}' --confirm '${target}'`,
            ),
          ).toEqual({ connectionId: target, status: "not-configured" });
          expect(await system.json(`integrations.get --connection-id '${target}'`)).toMatchObject({
            configuration: { status: "missing", missingFields: ["link"] },
            authorization: { status: "available" },
          });
          const reconfigure = await system.exec(
            `integrations.reconfigure --connection-id '${target}'`,
          );
          assert(reconfigure.exitCode === 1);
          expect(reconfigure.stderr).toContain("installation settings");
          expect(
            (await system.json("integrations.list")).connections.map(
              (connection: { connectionId: string }) => connection.connectionId,
            ),
          ).toEqual(["github#acme/web"]);
          expect(await system.json(setup(target, { link: true }))).toEqual({
            status: "ready",
            connectionId: target,
          });
        },
      ),
      runner.drain(),
      then.automation.event({
        scope,
        where: { source: "integrations", eventType: "connection.disconnected" },
        expected: { subject: { service: "github", connectionId: "github#acme/project" } },
      }),
    ],
  }));
});

test("a personal workspace connects a repository and receives its webhooks", async () => {
  await runGitHubIntegrationScenario((github) => ({
    name: "GitHub repository connections in a personal workspace",
    setup: ({ given }) => [
      given.auth.user({ id: ownerUserId, email: "owner@example.test" }),
      given.organization.exists({ id: scope.orgId, name: "GitHub Org" }),
    ],
    steps: ({ then, runner }) => [
      then.assert("an app already installed on GitHub links in one sign-in", async (ctx) => {
        const user = await createTerminal(
          ctx,
          createBackofficeUserExecution({ scope: personalScope, userId: ownerUserId }),
        );
        expect(await user.json("integrations.discover")).toContainEqual(
          expect.objectContaining({ id: "github", availability: { status: "available" } }),
        );
        const authorization = await user.json(setup("github#acme/project", { link: true }));
        expect(authorization).toMatchObject({ status: "needs-authorization" });
        // Installed on GitHub directly, so no workspace knows the installation yet.
        github.userInstallations = [acmeInstallation];
        expect(await returnFromSignIn(ctx, personalScope, authorization.authorizationUrl)).toEqual(
          boundAcme(["acme/project"]),
        );
        expect(await user.json(setup("github#acme/project"))).toEqual({
          status: "ready",
          connectionId: "github#acme/project",
        });
        const organization = await createTerminal(ctx, createBackofficeSystemExecution(scope));
        expect((await organization.json("integrations.list")).connections).toEqual([]);
        await deliverGitHubWebhook(ctx, "pull_request", pullRequestOpened);
      }),
      runner.drain(),
      then.automation.event({
        scope: personalScope,
        where: { source: "integrations", eventType: "connection.ready" },
        expected: { subject: { service: "github", connectionId: "github#acme/project" } },
      }),
      then.automation.event({
        scope: personalScope,
        where: { source: "github", eventType: "webhook.received" },
        expected: {
          subject: {
            scope: personalScope,
            connectionId: "github#acme/project",
            pullRequestNumber: "7",
          },
        },
      }),
    ],
  }));
});

test("an install redirect binds only an installation the signed-in user reaches", async () => {
  await runGitHubIntegrationScenario((github) => ({
    name: "GitHub install redirects are verified, and installations move between workspaces",
    setup: ({ given }) => [
      given.auth.user({ id: ownerUserId, email: "owner@example.test" }),
      given.auth.organization({
        id: scope.orgId,
        slug: "github-org",
        name: "GitHub Org",
        ownerUserId,
      }),
    ],
    steps: ({ then, runner }) => [
      then.assert(
        "a forged installation id fails the sign-in, and the installation stays unbound",
        async (ctx) => {
          const user = await createTerminal(
            ctx,
            createBackofficeUserExecution({ scope, userId: ownerUserId }),
          );
          const authorization = await user.json(setup("github#acme/project", { link: true }));
          const signedIn = await returnFromSignIn(ctx, scope, authorization.authorizationUrl);
          assert(signedIn.kind === "install");
          // Instead of installing, the user returns to the callback with someone else's
          // installation, which their GitHub account cannot access.
          const verifying = await returnFromInstall(ctx, scope, signedIn.installUrl);
          expect(await returnFromSignIn(ctx, scope, verifying)).toEqual({
            kind: "not-verified",
            installationId,
          });
          const router = ctx.runtime.objects.githubWebhookRouter.singleton().commands;
          expect(await router.getInstallationOwner(installationId)).toBeNull();
          expect(github.requests).toEqual([]);
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect((await system.json("integrations.list")).connections).toEqual([]);
        },
      ),
      then.assert(
        "an installation another workspace uses is reported with that workspace",
        async (ctx) => {
          github.userInstallations = [acmeInstallation];
          const personal = await createTerminal(
            ctx,
            createBackofficeUserExecution({ scope: personalScope, userId: ownerUserId }),
          );
          const personalLink = await personal.json(setup("github#acme/project", { link: true }));
          expect(await returnFromSignIn(ctx, personalScope, personalLink.authorizationUrl)).toEqual(
            boundAcme(["acme/project"]),
          );

          const user = await createTerminal(
            ctx,
            createBackofficeUserExecution({ scope, userId: ownerUserId }),
          );
          const authorization = await user.json(setup("github#acme/project", { link: true }));
          expect(await returnFromSignIn(ctx, scope, authorization.authorizationUrl)).toEqual({
            kind: "conflict",
            installation: { id: installationId, account: "acme", url: acmeInstallation.html_url },
            owner: personalScope,
          });
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect((await system.json("integrations.list")).connections).toEqual([]);
        },
      ),
      then.assert(
        "moving the installation disconnects it from the other workspace and links it here",
        async (ctx) => {
          // Meanwhile another sign-in in the old workspace reads its installation, then waits on
          // GitHub until the move finished.
          const personalUser = await createTerminal(
            ctx,
            createBackofficeUserExecution({ scope: personalScope, userId: ownerUserId }),
          );
          const lateLink = await personalUser.json(setup("github#acme/web", { link: true }));
          let finishMove = () => {};
          const moveDone = new Promise<void>((resolve) => {
            finishMove = resolve;
          });
          let readGitHub = () => {};
          const readingGitHub = new Promise<void>((resolve) => {
            readGitHub = resolve;
          });
          github.onInstallationRead = async () => {
            github.onInstallationRead = undefined;
            readGitHub();
            await moveDone;
          };
          const lateSignIn = returnFromSignIn(ctx, personalScope, lateLink.authorizationUrl);
          await readingGitHub;

          const automations = ctx.runtime.objects.automations.singleton().commands;
          const move = {
            installation: {
              id: installationId,
              accountId: String(githubAccount.id),
              accountLogin: "acme",
              accountType: "Organization",
              htmlUrl: acmeInstallation.html_url,
            },
            from: personalScope,
            to: scope,
            repositories: ["acme/project"],
          };
          const started = await automations.startGitHubInstallationMove({
            signInState: "move-sign-in",
            move,
          });
          // The page submitted twice finds the move already started.
          expect(
            await automations.startGitHubInstallationMove({ signInState: "move-sign-in", move }),
          ).toEqual(started);
          await ctx.drain();
          expect(await automations.readGitHubInstallationMove(started)).toEqual({
            status: "moved",
            outcome: boundAcme(["acme/project"]),
          });
          // A move from a workspace the installation no longer serves stops before changing anything.
          const stale = await automations.startGitHubInstallationMove({
            signInState: "stale-sign-in",
            move: {
              ...move,
              from: { kind: "org", orgId: "elsewhere", jurisdiction: null },
              to: personalScope,
            },
          });
          await ctx.drain();
          expect(await automations.readGitHubInstallationMove(stale)).toEqual({
            status: "failed",
            message: "The installation no longer serves the workspace it was moved from.",
          });
          // The late sign-in finds the installation moved, and does not take it back.
          finishMove();
          expect(await lateSignIn).toEqual({
            kind: "conflict",
            installation: { id: installationId, account: "acme", url: acmeInstallation.html_url },
            owner: scope,
          });
          const { router } = githubOf(ctx, scope);
          expect(await router.getInstallationOwner(installationId)).toEqual(scope);
          const organization = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect(
            (await organization.json("integrations.list")).connections.map(
              (connection: { connectionId: string }) => connection.connectionId,
            ),
          ).toEqual(["github#acme/project"]);
          const personal = await createTerminal(
            ctx,
            createBackofficeSystemExecution(personalScope),
          );
          expect((await personal.json("integrations.list")).connections).toEqual([]);
          expect(
            await personal.json(`integrations.get --connection-id 'github#acme/project'`),
          ).toMatchObject({ configuration: { status: "missing" } });
          // The old workspace's syncs leave the installation released.
          const resync = await githubOf(ctx, personalScope).callRoute(
            "POST",
            "/installations/:installationId/sync",
            { pathParams: { installationId } },
          );
          assert(resync.type === "error" && resync.error.code === "INSTALLATION_RELEASED");
        },
      ),
      runner.drain(),
      then.automation.event({
        scope: personalScope,
        where: { source: "integrations", eventType: "connection.disconnected" },
        expected: { subject: { service: "github", connectionId: "github#acme/project" } },
      }),
      then.assert(
        "a move back that a later move away overtakes cannot take the installation back",
        async (ctx) => {
          const organization = githubOf(ctx, scope);
          const personal = githubOf(ctx, personalScope);
          const installation = {
            id: installationId,
            accountId: String(githubAccount.id),
            accountLogin: "acme",
            accountType: "Organization",
            htmlUrl: acmeInstallation.html_url,
          };
          // A move back to the personal workspace routes the installation there and releases it in
          // the organization, then claims it in the personal workspace while GitHub answers slowly.
          assert(
            (await organization.router.moveInstallationOwner(installationId, scope, personalScope))
              .ok,
          );
          expect(
            await releaseGitHubInstallation({
              router: organization.router,
              callRoute: organization.callRoute,
              installation,
              owner: scope,
            }),
          ).toBeNull();
          let answerGitHub = () => {};
          const laterMoveDone = new Promise<void>((resolve) => {
            answerGitHub = resolve;
          });
          let readGitHub = () => {};
          const readingGitHub = new Promise<void>((resolve) => {
            readGitHub = resolve;
          });
          github.onInstallationRead = async () => {
            github.onInstallationRead = undefined;
            readGitHub();
            await laterMoveDone;
          };
          const returning = claimGitHubInstallation({
            router: personal.router,
            callRoute: personal.callRoute,
            installationId,
            owner: personalScope,
          });
          await readingGitHub;

          // Meanwhile a later move takes it to the organization again.
          const automations = ctx.runtime.objects.automations.singleton().commands;
          const later = await automations.startGitHubInstallationMove({
            signInState: "later-move-sign-in",
            move: { installation, from: personalScope, to: scope, repositories: ["acme/project"] },
          });
          await ctx.drain();
          expect(await automations.readGitHubInstallationMove(later)).toEqual({
            status: "moved",
            outcome: boundAcme(["acme/project"]),
          });

          // The move back's claim then conflicts, and claiming again finds it moved.
          answerGitHub();
          expect(await returning).toMatchObject({
            kind: "failed",
            failure: { code: "INSTALLATION_SYNC_CONFLICT" },
          });
          expect(
            await claimGitHubInstallation({
              router: personal.router,
              callRoute: personal.callRoute,
              installationId,
              owner: personalScope,
            }),
          ).toEqual({ kind: "moved", owner: scope });
          expect(await organization.router.getInstallationOwner(installationId)).toEqual(scope);
          const personalTerminal = await createTerminal(
            ctx,
            createBackofficeSystemExecution(personalScope),
          );
          expect((await personalTerminal.json("integrations.list")).connections).toEqual([]);
        },
      ),
    ],
  }));
});

test("without a GitHub App configuration, GitHub is unavailable and other integrations still list", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      objects: scenarioObjects,
      name: "GitHub integration without an app configuration",
      env: { GITHUB_APP_ID: "" },
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "GitHub Org" })],
      steps: ({ then }) => [
        then.assert("listing, discovery, and setup report GitHub as unavailable", async (ctx) => {
          const system = await createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect(await system.json("integrations.list")).toEqual({
            connections: [],
            unavailableSources: [],
            cursor: null,
          });
          expect(await system.json("integrations.discover")).toContainEqual(
            expect.objectContaining({
              id: "github",
              availability: {
                status: "unavailable",
                reason: "The GitHub App is not configured for this environment.",
              },
            }),
          );
          expect(await system.json(setup("github#acme/project"))).toMatchObject({
            status: "blocked",
            reason: "The GitHub App is not configured for this environment.",
          });
        }),
      ],
    }),
  );
});
