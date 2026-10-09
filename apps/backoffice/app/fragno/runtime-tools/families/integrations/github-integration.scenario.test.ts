import { assert, expect, test, vi } from "vitest";

import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRouteCaller } from "@fragno-dev/core/api";

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
import type { GitHubFragment } from "@/fragno/github";
import { completeGitHubInstallCallback } from "@/fragno/github-install-callback";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { bytesToHex } from "@/lib/crypto";

import { InMemoryGitHubObject } from "../../../../../workers/github.do";

const scope = { kind: "org", orgId: "github-org" } as const;
const ownerUserId = "github-owner";
const installationId = "4242";
const webhookSecret = "github-integration-webhook-secret";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

type GitHubRepositoryFixture = { id: number; name: string; full_name: string; private: boolean };

/** GitHub's view of the installation: what the user selected on github.com. */
type FakeGitHub = {
  repositories: GitHubRepositoryFixture[];
  requests: string[];
  /** Restrictions requested for each installation token, in order. */
  tokenRequests: unknown[];
};

const project = { id: 101, name: "project", full_name: "acme/project", private: false };
const web = { id: 102, name: "web", full_name: "acme/web", private: true };
const githubAccount = { login: "acme", id: 77, type: "Organization" };

async function runGitHubIntegrationScenario<TVars extends Record<string, unknown>>(
  defineScenario: (github: FakeGitHub) => BackofficeScenarioDefinitionInput<TVars>,
) {
  const github: FakeGitHub = { repositories: [project], requests: [], tokenRequests: [] };
  const githubFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert(url.origin === "https://api.github.com", `Unexpected GitHub request to ${url.origin}`);
    github.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname === `/app/installations/${installationId}`) {
      return Response.json({
        id: Number(installationId),
        account: githubAccount,
        suspended_at: null,
        permissions: { pull_requests: "read" },
        events: ["pull_request"],
      });
    }
    if (
      request.method === "POST" &&
      url.pathname === `/app/installations/${installationId}/access_tokens`
    ) {
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
        objectOverrides: {
          ...scenario.objectOverrides,
          GITHUB: (options) =>
            new InMemoryGitHubObject({ ...options, env: options.env as never, fetch: githubFetch }),
        },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createTerminal(ctx: BackofficeScenarioContext, execution: BackofficeExecutionContext) {
  const runtime: BackofficeRuntimeServices = ctx.runtime.services;
  const context = createRouteBackedRuntimeContext({
    runtime,
    execution,
    kernel: new BackofficeKernel(runtime),
    billingOrganizationId: null,
  });
  assert(context.stateBackend);
  const { bash } = createInteractiveBashHost({
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
        "x-github-delivery": `delivery-${event}-${crypto.randomUUID()}`,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${bytesToHex(new Uint8Array(signature))}`,
      },
      body,
    }),
  );
  expect(response.ok, await response.clone().text()).toBe(true);
}

/** Runs the setup callback's completion as the member who returns from GitHub. */
async function completeInstall(ctx: BackofficeScenarioContext, state: string) {
  const execution = createBackofficeUserExecution({ scope, userId: ownerUserId });
  const kernel = new BackofficeKernel(ctx.runtime.services);
  const github = kernel.scoped("GITHUB", scope, ctx.runtime.objects.github);
  const transport = authorizedBackofficeObjectHttp(github.http, execution);
  return await completeGitHubInstallCallback({
    router: ctx.runtime.objects.githubWebhookRouter.singleton().commands,
    github: github.commands,
    callRoute: createRouteCaller<GitHubFragment>({
      baseUrl: "https://github.do",
      mountRoute: "/api/github",
      fetch: async (request) => {
        await github.commands.ensureAdminConfig(scope.orgId);
        return await transport.fetch(request);
      },
    }),
    userId: ownerUserId,
    organizationId: scope.orgId,
    state,
    installationId,
  });
}

test("a repository becomes a connection after the GitHub App is installed, linked, used, and unlinked", async () => {
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
          const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
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
          const user = createTerminal(
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
          const installUrl = new URL(authorization.authorizationUrl);
          assert(installUrl.pathname === "/apps/in-memory-github-app/installations/new");
          const state = installUrl.searchParams.get("state");
          assert(state);
          // GitHub returns to the setup callback after the user selects acme/project.
          assert((await completeInstall(ctx, state)) === "installed_synced");
          expect(github.requests).toEqual([
            `GET /app/installations/${installationId}`,
            `POST /app/installations/${installationId}/access_tokens`,
            "GET /installation/repositories",
          ]);
          // The callback used acme's link, so setup no longer offers it; octo's link is untouched.
          const router = ctx.runtime.objects.githubWebhookRouter.singleton().commands;
          expect(await router.getPendingInstall(ownerUserId, scope.orgId, "acme")).toBeNull();
          expect(await user.json(setup("github#octo/tools"))).toEqual(octoAuthorization);
          // Choosing acme again on GitHub's page for octo's link is reported, not silently dropped.
          const octoState = new URL(octoAuthorization.authorizationUrl).searchParams.get("state");
          assert(octoState);
          assert((await completeInstall(ctx, octoState)) === "installed_other_account");
          expect(await user.json(setup("github#octo/tools"))).toMatchObject({
            status: "needs-input",
            connectionId: "github#octo/tools",
          });
        },
      ),
      then.assert(
        "returning from GitHub linked the requested repository, so setup is ready and it lists",
        async (ctx) => {
          const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
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
          const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
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
        const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
        const target = "--connection-id 'github#acme/project'";
        expect(await system.json(`integrations.actions ${target}`)).toMatchObject([
          { id: "pulls.list" },
          { id: "repository.access-token.create" },
          { id: "api.request" },
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
        await deliverGitHubWebhook(ctx, "pull_request", {
          action: "opened",
          installation: { id: Number(installationId) },
          repository: { ...project, owner: { login: "acme", id: 77 } },
          pull_request: { id: 1, number: 7, title: "Add webhook support", state: "open" },
          sender: { login: "octo-dev", id: 10 },
        });
      }),
      runner.drain(),
      then.automation.event({
        scope,
        where: { source: "github", eventType: "webhook.received" },
        expected: {
          subject: { connectionId: "github#acme/project", pullRequestNumber: "7" },
        },
      }),
      then.assert("GitHub suspends the installation", async (ctx) => {
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
        await deliverGitHubWebhook(ctx, "installation", {
          action: "unsuspend",
          installation: { id: Number(installationId), account: githubAccount },
        });
      }),
      runner.drain(),
      then.assert("restored repositories are available again", async (ctx) => {
        const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
        expect(
          await system.json(`integrations.get --connection-id 'github#acme/web'`),
        ).toMatchObject({ authorization: { status: "available" } });
      }),
      then.assert(
        "disconnecting unlinks the repository but leaves GitHub access in place",
        async (ctx) => {
          const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
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

test("without a GitHub App configuration, GitHub is unavailable and other integrations still list", async () => {
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "GitHub integration without an app configuration",
      env: { GITHUB_APP_ID: "" },
      setup: ({ given }) => [given.organization.exists({ id: scope.orgId, name: "GitHub Org" })],
      steps: ({ then }) => [
        then.assert("listing, discovery, and setup report GitHub as unavailable", async (ctx) => {
          const system = createTerminal(ctx, createBackofficeSystemExecution(scope));
          expect(await system.json("integrations.list")).toEqual({ connections: [], cursor: null });
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
