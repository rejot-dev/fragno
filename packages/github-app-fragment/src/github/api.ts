import { App, Octokit } from "octokit";

import type { GitHubAppFragmentConfig } from "./types";

type GitHubApiClientOptions = {
  fetch?: typeof fetch;
};

export type GitHubInstallationRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  fork?: boolean;
  default_branch?: string | null;
  owner: { login: string };
};

export type GitHubPullRequest = Record<string, unknown>;

export type GitHubPullRequestReview = Record<string, unknown>;

type PullRequestState = "open" | "closed" | "all";
type PullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
type PullRequestReviewComment = {
  path: string;
  body: string;
  position?: number;
  line?: number;
  side?: string;
  start_line?: number;
  start_side?: string;
};

type GitHubInstallationRepositoriesResponse = {
  repositories: GitHubInstallationRepository[];
};
type GitHubInstallationRepositoriesApiResponse = {
  repositories?: GitHubInstallationRepository[];
  total_count?: number;
};

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2022-11-28";

export const createGitHubApiClient = (
  config: GitHubAppFragmentConfig,
  options: GitHubApiClientOptions = {},
) => {
  const fetchImpl = options.fetch ?? globalThis.fetch ?? undefined;
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  let app: App | null = null;

  const getApp = () => {
    if (app) {
      return app;
    }
    const OctokitForApp = Octokit.defaults({
      baseUrl: apiBaseUrl,
      ...(fetchImpl ? { request: { fetch: fetchImpl } } : {}),
    });

    app = new App({
      appId: config.appId,
      privateKey: config.privateKeyPem,
      webhooks: { secret: config.webhookSecret },
      Octokit: OctokitForApp,
    });
    return app;
  };

  const resolveInstallationId = (installationId: string) => {
    const numeric = Number.parseInt(installationId, 10);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(`Invalid installation id: ${installationId}`);
    }
    return numeric;
  };

  const getInstallationOctokit = async (installationId: string) => {
    return await getApp().getInstallationOctokit(resolveInstallationId(installationId));
  };

  const listInstallationRepos = async (installationId: string) => {
    const installationOctokit = await getInstallationOctokit(installationId);

    const repositories: GitHubInstallationRepository[] = [];
    const perPage = 100;
    let page = 1;

    while (true) {
      const response = await installationOctokit.request("GET /installation/repositories", {
        page,
        per_page: perPage,
        headers: { "x-github-api-version": apiVersion },
        request: { retries: 0 },
      });
      const responseData = response.data as GitHubInstallationRepositoriesApiResponse;
      const pageRepositories = responseData.repositories ?? [];
      repositories.push(...pageRepositories);

      const totalCount = responseData.total_count;
      if (pageRepositories.length === 0) {
        break;
      }
      if (typeof totalCount === "number" && repositories.length >= totalCount) {
        break;
      }
      if (pageRepositories.length < perPage) {
        break;
      }
      page += 1;
    }

    return {
      repositories,
    } satisfies GitHubInstallationRepositoriesResponse;
  };

  const listPullRequests = async (options: {
    installationId: string;
    owner: string;
    repo: string;
    state?: PullRequestState;
    perPage?: number;
    page?: number;
  }) => {
    const installationOctokit = await getInstallationOctokit(options.installationId);
    const response = await installationOctokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: options.owner,
      repo: options.repo,
      state: options.state,
      per_page: options.perPage,
      page: options.page,
      headers: { "x-github-api-version": apiVersion },
      request: { retries: 0 },
    });
    return response.data as GitHubPullRequest[];
  };

  const createPullRequestReview = async (options: {
    installationId: string;
    owner: string;
    repo: string;
    pullNumber: number;
    event?: PullRequestReviewEvent;
    body?: string;
    comments?: PullRequestReviewComment[];
    commitId?: string;
  }) => {
    const installationOctokit = await getInstallationOctokit(options.installationId);
    const response = await installationOctokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner: options.owner,
        repo: options.repo,
        pull_number: options.pullNumber,
        event: options.event,
        body: options.body,
        comments: options.comments,
        commit_id: options.commitId,
        headers: { "x-github-api-version": apiVersion },
        request: { retries: 0 },
      },
    );
    return response.data as GitHubPullRequestReview;
  };

  const verifyWebhookSignature = async (options: {
    payload: string;
    signatureHeader: string | null;
  }) => {
    if (!options.signatureHeader) {
      return false;
    }
    try {
      return await getApp().webhooks.verify(options.payload, options.signatureHeader);
    } catch {
      return false;
    }
  };

  return {
    listInstallationRepos,
    listPullRequests,
    createPullRequestReview,
    verifyWebhookSignature,
  };
};
