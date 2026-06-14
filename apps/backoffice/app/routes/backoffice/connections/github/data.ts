import { createRouteCaller } from "@fragno-dev/core/api";
import type { RouterContextProvider } from "react-router";

import type { GitHubFragment } from "@/fragno/github";
import {
  GITHUB_WEBHOOK_ROUTER_SINGLETON_ID,
  getGitHubDurableObject,
  getGitHubWebhookRouterDurableObject,
} from "@/worker-runtime/durable-objects";

import {
  booleanActionResultFromCaughtError,
  booleanActionResultFromRouteResponse,
  nullableDataActionResultFromCaughtError,
  nullableDataActionResultFromRouteResponse,
  type RouteActionResponse,
} from "../../action-result";
import type { GitHubAdminConfigState } from "./shared";

export type GitHubInstallationSummary = {
  id: string;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: string;
  permissions: unknown;
  events: unknown;
  createdAt: string | Date;
  updatedAt: string | Date;
  lastWebhookAt: string | Date | null;
};

export type GitHubRepositorySummary = {
  id: string;
  installationId: string;
  ownerLogin: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  isFork: boolean;
  defaultBranch: string | null;
  removedAt: string | Date | null;
  updatedAt: string | Date;
  linkKeys: string[];
};

type GitHubPullsResponse = {
  pulls: Array<Record<string, unknown>>;
  pageInfo: {
    page: number;
    perPage: number;
  };
};

type GitHubLinkResponse = {
  link: {
    id: string;
    repoId: string;
    linkKey: string;
    linkedAt: string | Date;
  };
  repo: GitHubRepositorySummary;
};

type GitHubAdminConfigResult = {
  configState: GitHubAdminConfigState | null;
  configError: string | null;
};

type GitHubInstallationsResult = {
  installations: GitHubInstallationSummary[];
  installationsError: string | null;
};

type GitHubReposResult = {
  repos: GitHubRepositorySummary[];
  reposError: string | null;
};

type GitHubPullsResult = {
  pulls: Array<Record<string, unknown>>;
  pageInfo: GitHubPullsResponse["pageInfo"] | null;
  pullsError: string | null;
};

type GitHubLinkResult = {
  result: GitHubLinkResponse | null;
  error: string | null;
};

type GitHubUnlinkResult = {
  ok: boolean;
  error: string | null;
};

type GitHubSyncResult = {
  result: { added: number; removed: number; updated: number } | null;
  error: string | null;
};

const createGitHubRouteCaller = (
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
) => {
  const githubDo = getGitHubDurableObject(context, orgId);
  return createRouteCaller<GitHubFragment>({
    baseUrl: request.url,
    mountRoute: "/api/github",
    baseHeaders: request.headers,
    fetch: async (outboundRequest) => {
      await githubDo.ensureAdminConfig(orgId);
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return await githubDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

const gitHubReposResultFromRouteResponse = (
  response: RouteActionResponse,
  failureMessage: string,
): GitHubReposResult => {
  const result = nullableDataActionResultFromRouteResponse<GitHubRepositorySummary[]>({
    response,
    failureMessage,
  });
  return { repos: result.result ?? [], reposError: result.error };
};

const gitHubReposResultFromCaughtError = (error: unknown, fallback: string): GitHubReposResult => ({
  repos: [],
  reposError: error instanceof Error ? error.message : fallback,
});

export async function fetchGitHubAdminConfig(
  context: Readonly<RouterContextProvider>,
  _orgId: string,
  origin: string,
): Promise<GitHubAdminConfigResult> {
  try {
    const githubRouterDo = getGitHubWebhookRouterDurableObject(context);
    const configState = await githubRouterDo.getAdminConfig(
      GITHUB_WEBHOOK_ROUTER_SINGLETON_ID,
      origin,
    );
    return { configState, configError: null };
  } catch (error) {
    return {
      configState: null,
      configError: error instanceof Error ? error.message : "Failed to load configuration.",
    };
  }
}

export async function fetchGitHubInstallations(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  status?: "active" | "suspended" | "deleted",
): Promise<GitHubInstallationsResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const query = status ? { status } : undefined;
    const response = await callRoute("GET", "/installations", { query });

    if (response.type === "json") {
      return {
        installations: response.data as GitHubInstallationSummary[],
        installationsError: null,
      };
    }

    if (response.type === "error") {
      return {
        installations: [],
        installationsError: response.error.message,
      };
    }

    return {
      installations: [],
      installationsError: `Failed to fetch installations (${response.status}).`,
    };
  } catch (error) {
    return {
      installations: [],
      installationsError: error instanceof Error ? error.message : "Failed to load installations.",
    };
  }
}

export async function fetchGitHubInstallationRepos(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  installationId: string,
  options: { linkedOnly?: boolean } = {},
): Promise<GitHubReposResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const query: Record<string, string> = {};
    if (options.linkedOnly) {
      query.linkedOnly = "true";
    }

    const response = await callRoute("GET", "/installations/:installationId/repos", {
      pathParams: { installationId },
      query,
    });

    return gitHubReposResultFromRouteResponse(response, "Failed to fetch repositories");
  } catch (error) {
    return gitHubReposResultFromCaughtError(error, "Failed to load repositories.");
  }
}

export async function fetchGitHubLinkedRepositories(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
): Promise<GitHubReposResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const response = await callRoute("GET", "/repositories/linked");

    return gitHubReposResultFromRouteResponse(response, "Failed to fetch linked repositories");
  } catch (error) {
    return gitHubReposResultFromCaughtError(error, "Failed to load linked repositories.");
  }
}

export async function fetchGitHubPulls(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  options: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
    page?: number;
    perPage?: number;
  },
): Promise<GitHubPullsResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const query: Record<string, string> = {};
    if (options.state) {
      query.state = options.state;
    }
    if (options.page) {
      query.page = String(options.page);
    }
    if (options.perPage) {
      query.perPage = String(options.perPage);
    }

    const response = await callRoute("GET", "/repositories/:owner/:repo/pulls", {
      pathParams: { owner: options.owner, repo: options.repo },
      query,
    });

    if (response.type === "json") {
      const data = response.data as GitHubPullsResponse;
      return {
        pulls: data.pulls ?? [],
        pageInfo: data.pageInfo ?? null,
        pullsError: null,
      };
    }

    if (response.type === "error") {
      return {
        pulls: [],
        pageInfo: null,
        pullsError: response.error.message,
      };
    }

    return {
      pulls: [],
      pageInfo: null,
      pullsError: `Failed to fetch pull requests (${response.status}).`,
    };
  } catch (error) {
    return {
      pulls: [],
      pageInfo: null,
      pullsError: error instanceof Error ? error.message : "Failed to load pull requests.",
    };
  }
}

export async function linkGitHubRepository(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: { installationId: string; repoId: string; linkKey?: string },
): Promise<GitHubLinkResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/repositories/link", { body: payload });

    return nullableDataActionResultFromRouteResponse<GitHubLinkResponse>({
      response,
      failureMessage: "Failed to link repository",
    });
  } catch (error) {
    return nullableDataActionResultFromCaughtError(error, "Failed to link repository.");
  }
}

export async function syncGitHubInstallation(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  installationId: string,
): Promise<GitHubSyncResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/installations/:installationId/sync", {
      pathParams: { installationId },
    });

    return nullableDataActionResultFromRouteResponse<{
      added: number;
      removed: number;
      updated: number;
    }>({
      response,
      failureMessage: "Failed to sync installation",
    });
  } catch (error) {
    return nullableDataActionResultFromCaughtError(error, "Failed to sync installation.");
  }
}

export async function unlinkGitHubRepository(
  request: Request,
  context: Readonly<RouterContextProvider>,
  orgId: string,
  payload: { repoId: string; linkKey?: string },
): Promise<GitHubUnlinkResult> {
  try {
    const callRoute = createGitHubRouteCaller(request, context, orgId);
    const response = await callRoute("POST", "/repositories/unlink", { body: payload });

    return booleanActionResultFromRouteResponse({
      response,
      failureMessage: "Failed to unlink repository",
    });
  } catch (error) {
    return booleanActionResultFromCaughtError(error, "Failed to unlink repository.");
  }
}
