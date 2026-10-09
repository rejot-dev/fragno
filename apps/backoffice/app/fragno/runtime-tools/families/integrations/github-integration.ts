import { createRouteCaller } from "@fragno-dev/core/api";
import { z } from "zod";

import type { GitHubRepositoryAccess } from "@fragno-dev/github-app-fragment";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { GitHubFragment } from "@/fragno/github";
import { jsonValueSchema } from "@/lib/zod/json-value";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../../runtime-errors";
import type {
  IntegrationConnection,
  IntegrationInspection,
  IntegrationSetupProgress,
} from "./integration-contracts";
import type { IntegrationContext, IntegrationImplementation } from "./integration-implementation";

const GITHUB_CONNECTION_NAMESPACE = "github";
const GITHUB_INTEGRATION_ID = "github";

/** Repositories are addressed by full name, so an agent can name one before it is linked. */
export function encodeGitHubRepositoryConnectionId(fullName: string) {
  return `${GITHUB_CONNECTION_NAMESPACE}#${fullName}`;
}

const githubRepositoryFullNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/,
    "GitHub address must be github#owner/repo.",
  );
const githubLinkInputSchema = z.strictObject({
  link: z.literal(true).describe("Link this repository to the organization."),
});
const githubPullsListInputSchema = z.strictObject({
  state: z.enum(["open", "closed", "all"]).nullable().describe("Null lists open pull requests."),
  perPage: z.number().int().min(1).max(100).nullable().describe("Null uses 30."),
  page: z.number().int().min(1).nullable().describe("Null starts at page 1."),
});
const githubPullsListOutputSchema = z.strictObject({
  pulls: z.array(z.record(z.string(), jsonValueSchema)),
  pageInfo: z.strictObject({ page: z.number(), perPage: z.number() }),
});
const githubPullsListActionDefinition = {
  id: "pulls.list",
  label: "List pull requests",
  description: "List pull requests in this repository through the GitHub App installation.",
  inputSchema: z.toJSONSchema(githubPullsListInputSchema, { io: "input" }),
  outputSchema: z.toJSONSchema(githubPullsListOutputSchema, { io: "output" }),
};
const githubAccessTokenOutputSchema = z.strictObject({
  token: z.string().describe("Credential; keep it out of logs, files, and replies."),
  expiresAt: z.string(),
});
const githubAccessTokenActionDefinition = {
  id: "repository.access-token.create",
  label: "Create repository access token",
  description:
    "Create a short-lived token that can only read this repository's contents, e.g. to clone it with https://x-access-token:<token>@github.com/owner/repo.git.",
  inputSchema: z.toJSONSchema(z.strictObject({}), { io: "input" }),
  outputSchema: z.toJSONSchema(githubAccessTokenOutputSchema, { io: "output" }),
};
const githubApiRequestInputSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z
    .string()
    .describe(
      "GitHub REST path under /repos/{owner}/{repo}, e.g. /issues or /contents/README.md; empty for the repository itself.",
    ),
  query: z.record(z.string(), z.string()).nullable().describe("Null sends no query string."),
  body: jsonValueSchema.describe("JSON request body; null sends none."),
});
const githubApiRequestOutputSchema = z.strictObject({
  status: z
    .number()
    .int()
    .describe("GitHub's HTTP status; error statuses are returned, not thrown."),
  headers: z
    .record(z.string(), z.string())
    .describe("Only link (pagination) and x-ratelimit-* headers."),
  body: jsonValueSchema,
});
const githubApiRequestActionDefinition = {
  id: "api.request",
  label: "Call the GitHub REST API",
  description:
    "Send a GitHub REST API request about this repository, using the app's installation permissions restricted to this repository. Paths outside /repos/{owner}/{repo} are rejected.",
  inputSchema: z.toJSONSchema(githubApiRequestInputSchema, { io: "input" }),
  outputSchema: z.toJSONSchema(githubApiRequestOutputSchema, { io: "output" }),
};
const githubRepositoryReadCheck = { id: "pulls.read", label: "Read pull requests" };

type GitHubCallRoute = ReturnType<typeof createRouteCaller<GitHubFragment>>;
type GitHubRouteResponse = Awaited<ReturnType<GitHubCallRoute>>;

function parseGitHubAddress(localId: string) {
  const fullName = githubRepositoryFullNameSchema.parse(localId);
  const slash = fullName.indexOf("/");
  return { fullName, owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function inspectGitHubRepository(access: GitHubRepositoryAccess): IntegrationInspection {
  if (access.status !== "reachable") {
    return {
      configuration: { status: "missing", missingFields: ["link"] },
      authorization: { status: "missing" },
      checks: [
        {
          ...githubRepositoryReadCheck,
          status: "not-checked",
          reason: "The GitHub App cannot reach this repository.",
        },
      ],
      nextSteps: [
        "Run integrations.setup to grant the GitHub App access to this repository and link it.",
      ],
    };
  }
  const active = access.installation.status === "active";
  const linked = access.repository.linked;
  return {
    configuration: linked
      ? { status: "configured" }
      : { status: "missing", missingFields: ["link"] },
    authorization: { status: active ? "available" : "missing" },
    checks: [
      {
        ...githubRepositoryReadCheck,
        status: "not-checked",
        reason: linked
          ? "No retained live repository check is available."
          : "Link the repository before checking access.",
      },
    ],
    nextSteps: [
      ...(active
        ? []
        : [
            `The GitHub App installation is ${access.installation.status}; restore it in GitHub's installation settings.`,
          ]),
      ...(linked ? [] : ["Run integrations.setup to link this repository."]),
    ],
  };
}

/**
 * Each linked repository is a connection; the GitHub App installation that reaches it is shared
 * authorization. Repository access is granted on GitHub, never through Backoffice input.
 */
export function createGitHubIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  function isGitHubAvailable(context: IntegrationContext) {
    return (
      context.execution.scope.kind === "org" &&
      runtime.config.bindings.github &&
      runtime.config.bindings.githubWebhookRouter
    );
  }

  /** Why GitHub cannot serve this scope, or null; a missing app configuration is not an error. */
  async function unavailableReason(context: IntegrationContext): Promise<string | null> {
    if (context.execution.scope.kind !== "org") {
      return "GitHub repositories are organization-owned.";
    }
    if (!isGitHubAvailable(context)) {
      return "The GitHub object bindings are unavailable.";
    }
    if (!(await runtime.objects.githubWebhookRouter.singleton().commands.isAppConfigured())) {
      return "The GitHub App is not configured for this environment.";
    }
    return null;
  }

  function createGitHubAccess(context: IntegrationContext) {
    const scope = context.execution.scope;
    if (scope.kind !== "org" || !isGitHubAvailable(context)) {
      throw new BackofficeUnavailableError(
        "GitHub integration requires an organization with the GitHub App bindings.",
      );
    }
    const orgId = scope.orgId;
    const object = context.kernel.scoped("GITHUB", scope, runtime.objects.github);
    const transport = authorizedBackofficeObjectHttp(object.http, context.execution);
    const callRoute = createRouteCaller<GitHubFragment>({
      baseUrl: "https://github.do",
      mountRoute: "/api/github",
      fetch: async (request) => {
        // The fragment is configured lazily from environment secrets on first use.
        await object.commands.ensureAdminConfig(orgId);
        return await transport.fetch(request);
      },
    });

    function invoke<TResult>(
      operation: BackofficePermissionRequirement,
      resource: Record<string, string>,
      execute: () => Promise<TResult>,
    ) {
      return context.kernel.invoke({
        execution: context.execution,
        operation,
        resource: { capabilityId: "github", ...resource },
        execute,
      });
    }

    function fail(response: GitHubRouteResponse): never {
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "GitHub integration",
        label: "GitHub source operation",
      });
    }

    function repositoryPath(fullName: string) {
      const slash = fullName.indexOf("/");
      return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
    }

    async function repositoryAccess(fullName: string): Promise<GitHubRepositoryAccess> {
      const response = await invoke(
        BACKOFFICE_PERMISSION.connections.read,
        { repository: fullName },
        () =>
          callRoute("GET", "/repositories/:owner/:repo", { pathParams: repositoryPath(fullName) }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response);
    }

    /** Sync asks GitHub for the installation's current repositories, so checks see new grants. */
    async function readRepositoryAccess(
      fullName: string,
      { sync }: { sync: boolean },
    ): Promise<GitHubRepositoryAccess> {
      const access = await repositoryAccess(fullName);
      if (!sync || access.status !== "not-granted" || access.installation.status !== "active") {
        return access;
      }
      const installationId = access.installation.id;
      const response = await invoke(
        BACKOFFICE_PERMISSION.connections.manage,
        { installationId },
        () =>
          callRoute("POST", "/installations/:installationId/sync", {
            pathParams: { installationId },
          }),
      );
      if (!(response.type === "json" && isSuccessStatus(response.status))) {
        fail(response);
      }
      return await repositoryAccess(fullName);
    }

    async function linkRepository(fullName: string) {
      const response = await invoke(
        BACKOFFICE_PERMISSION.connections.manage,
        { repository: fullName },
        () =>
          callRoute("POST", "/repositories/:owner/:repo/link", {
            pathParams: repositoryPath(fullName),
            body: {},
          }),
      );
      if (!(response.type === "json" && isSuccessStatus(response.status))) {
        fail(response);
      }
    }

    async function unlinkRepository(fullName: string) {
      const response = await invoke(
        BACKOFFICE_PERMISSION.connections.manage,
        { repository: fullName },
        () =>
          callRoute("POST", "/repositories/:owner/:repo/unlink", {
            pathParams: repositoryPath(fullName),
            body: {},
          }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data.status;
      }
      return fail(response);
    }

    async function linkedRepositories() {
      const response = await invoke(BACKOFFICE_PERMISSION.connections.read, {}, () =>
        callRoute("GET", "/repositories/linked"),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response);
    }

    /** Install state is bound to the user who must complete GitHub's callback. */
    async function pendingInstall(userId: string, owner: string) {
      const router = runtime.objects.githubWebhookRouter.singleton();
      return await invoke(BACKOFFICE_PERMISSION.connections.manage, { owner }, () =>
        router.commands.getPendingInstall(userId, orgId, owner),
      );
    }

    /** GitHub's install callback links the repository once the user grants access. */
    async function requestInstall(userId: string, fullName: string) {
      const router = runtime.objects.githubWebhookRouter.singleton();
      const requested = await invoke(
        BACKOFFICE_PERMISSION.connections.manage,
        { repository: fullName },
        () => router.commands.requestRepositoryInstall(userId, orgId, fullName),
      );
      if (!requested.ok) {
        throw new BackofficeUnavailableError(requested.message);
      }
      return requested.installUrl;
    }

    function listPulls(
      owner: string,
      repo: string,
      query: { state: string; perPage: string; page: string },
    ) {
      return invoke(
        BACKOFFICE_PERMISSION.connections.read,
        { repository: `${owner}/${repo}` },
        () =>
          callRoute("GET", "/repositories/:owner/:repo/pulls", {
            pathParams: { owner, repo },
            query,
          }),
      );
    }

    async function createAccessToken(fullName: string) {
      const access = await repositoryAccess(fullName);
      if (access.status !== "reachable" || !access.repository.linked) {
        throw new BackofficeUnavailableError(
          `${fullName} is not linked to this organization. Run integrations.setup first.`,
        );
      }
      const repoId = access.repository.id;
      const response = await invoke(
        BACKOFFICE_PERMISSION.connections.read,
        { repository: fullName },
        () => callRoute("POST", "/repositories/access-token", { body: { repoId } }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return { token: response.data.token, expiresAt: response.data.expiresAt };
      }
      return fail(response);
    }

    async function requestApi(
      fullName: string,
      request: z.output<typeof githubApiRequestInputSchema>,
    ) {
      const response = await invoke(
        BACKOFFICE_PERMISSION.connections.manage,
        { repository: fullName, method: request.method },
        () =>
          callRoute("POST", "/repositories/:owner/:repo/api", {
            pathParams: repositoryPath(fullName),
            body: { ...request, query: request.query ?? {} },
          }),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return githubApiRequestOutputSchema.parse(response.data);
      }
      return fail(response);
    }

    return {
      createAccessToken,
      requestApi,
      readRepositoryAccess,
      linkRepository,
      unlinkRepository,
      linkedRepositories,
      pendingInstall,
      requestInstall,
      listPulls,
    };
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: GITHUB_CONNECTION_NAMESPACE }],
    setup: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const { fullName, owner } = parseGitHubAddress(localId);
        const connectionId = encodeGitHubRepositoryConnectionId(fullName);
        const unavailable = await unavailableReason(context);
        if (unavailable !== null) {
          return { status: "blocked", connectionId, reason: unavailable };
        }
        const github = createGitHubAccess(context);
        const access = await github.readRepositoryAccess(fullName, { sync: true });
        if (operation.kind === "input") {
          githubLinkInputSchema.parse(operation.input);
        }
        if (access.status === "reachable") {
          if (access.installation.status !== "active") {
            return {
              status: "blocked",
              connectionId,
              reason: `The GitHub App installation on ${owner} is ${access.installation.status}. Restore it in GitHub's installation settings, then run setup again.`,
            };
          }
          if (access.repository.linked || operation.kind === "input") {
            await github.linkRepository(fullName);
            return { status: "ready", connectionId };
          }
          return {
            status: "needs-input",
            connectionId,
            instructions: `The GitHub App can reach ${fullName}. Submit { "link": true } to link it to this organization.`,
            inputSchema: z.toJSONSchema(githubLinkInputSchema, { io: "input" }),
            secretFields: [],
          };
        }
        const principal = context.execution.actors.principal;
        const userId = principal?.type === "user" ? principal.id : null;
        const grantStep = access.status === "not-installed" ? "install" : "configure";
        const authorization = (authorizationUrl: string): IntegrationSetupProgress => ({
          status: "needs-authorization",
          connectionId,
          instructions: `Open the link and ${grantStep === "install" ? "install the GitHub App" : "configure the GitHub App installation"} on ${owner}, selecting ${fullName}. Returning from GitHub links the repository; then run setup again to confirm.`,
          authorizationUrl,
        });
        if (operation.kind === "check") {
          const pending = userId === null ? null : await github.pendingInstall(userId, owner);
          if (pending?.repositories.includes(fullName)) {
            return authorization(pending.installUrl);
          }
          return {
            status: "needs-input",
            connectionId,
            instructions:
              access.status === "not-installed"
                ? `The GitHub App is not installed on ${owner} for this organization. Submit { "link": true } to get a GitHub install link; returning from GitHub links ${fullName}.`
                : `The GitHub App installation on ${owner} cannot reach ${fullName}. Submit { "link": true } to get a GitHub link where the user adds it; returning from GitHub links it.`,
            inputSchema: z.toJSONSchema(githubLinkInputSchema, { io: "input" }),
            secretFields: [],
          };
        }
        if (userId === null) {
          return {
            status: "blocked",
            connectionId,
            reason:
              "Granting GitHub access requires a signed-in user, because GitHub returns the installation to the user who started it.",
          };
        }
        return authorization(await github.requestInstall(userId, fullName));
      },
    },
    reconfigure: {
      kind: "unsupported",
      reason:
        "GitHub repository access is changed in the GitHub App's installation settings, not through Backoffice.",
    },
    disconnect: {
      kind: "supported",
      async run(context, { localId }) {
        const { fullName } = parseGitHubAddress(localId);
        const connectionId = encodeGitHubRepositoryConnectionId(fullName);
        if ((await unavailableReason(context)) !== null) {
          return { connectionId, status: "not-configured" };
        }
        const unlinked = await createGitHubAccess(context).unlinkRepository(fullName);
        return {
          connectionId,
          status: unlinked === "unlinked" ? "disconnected" : "not-configured",
        };
      },
    },
    async discover(context) {
      const unavailable = await unavailableReason(context);
      return [
        {
          id: GITHUB_INTEGRATION_ID,
          label: "GitHub",
          description:
            "GitHub repositories reached through this organization's GitHub App installations. Each linked repository is one connection, addressed as github#owner/repo.",
          connectionCardinality: "multiple",
          availability:
            unavailable === null
              ? { status: "available" }
              : { status: "unavailable", reason: unavailable },
          setupTargets: [],
          automationEvents: [{ source: "github", eventType: "webhook.received" }],
        },
      ];
    },
    async list(context, cursor) {
      if (cursor !== null) {
        throw new Error("GitHub integration listing cursor is invalid.");
      }
      if ((await unavailableReason(context)) !== null) {
        return { connections: [], cursor: null };
      }
      const repositories = await createGitHubAccess(context).linkedRepositories();
      return {
        connections: repositories.map(
          (repository): IntegrationConnection & { configuration: { status: "configured" } } => ({
            connectionId: encodeGitHubRepositoryConnectionId(repository.fullName),
            integrationId: GITHUB_INTEGRATION_ID,
            name: repository.fullName,
            ...inspectGitHubRepository({
              status: "reachable",
              // Linked listing only returns repositories of active installations.
              installation: { id: repository.installationId, status: "active" },
              repository: { id: repository.id, linked: true },
            }),
            configuration: { status: "configured" },
          }),
        ),
        cursor: null,
      };
    },
    async resolve(context, localId) {
      const { fullName, owner, repo } = parseGitHubAddress(localId);
      const identity = {
        connectionId: encodeGitHubRepositoryConnectionId(fullName),
        integrationId: GITHUB_INTEGRATION_ID,
        name: fullName,
      };
      const access = createGitHubAccess(context);
      async function inspect() {
        return inspectGitHubRepository(
          await access.readRepositoryAccess(fullName, { sync: false }),
        );
      }
      return {
        identity,
        inspect,
        async actions() {
          return [
            {
              definition: githubPullsListActionDefinition,
              async invoke(input) {
                const values = githubPullsListInputSchema.parse(input);
                const response = await access.listPulls(owner, repo, {
                  state: values.state ?? "open",
                  perPage: String(values.perPage ?? 30),
                  page: String(values.page ?? 1),
                });
                if (response.type === "json" && isSuccessStatus(response.status)) {
                  return githubPullsListOutputSchema.parse(response.data);
                }
                return throwOnRouteRuntimeError(response, {
                  runtimeLabel: "GitHub integration",
                  label: "GitHub pull request listing",
                });
              },
            },
            {
              definition: githubAccessTokenActionDefinition,
              async invoke(input) {
                z.strictObject({}).parse(input);
                return await access.createAccessToken(fullName);
              },
            },
            {
              definition: githubApiRequestActionDefinition,
              async invoke(input) {
                return await access.requestApi(fullName, githubApiRequestInputSchema.parse(input));
              },
            },
          ];
        },
        async verify() {
          const inspection = await inspect();
          if (inspection.configuration.status === "missing") {
            return inspection;
          }
          const response = await access.listPulls(owner, repo, {
            state: "open",
            perPage: "1",
            page: "1",
          });
          const passed = response.type === "json" && isSuccessStatus(response.status);
          return {
            ...inspection,
            checks: [
              {
                ...githubRepositoryReadCheck,
                status: passed ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message: passed
                  ? `GitHub returned pull requests for ${fullName}.`
                  : `GitHub pull request listing for ${fullName} failed (HTTP ${response.status}).`,
              },
            ],
          };
        },
      };
    },
  };
}
