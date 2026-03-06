import { App, Octokit } from "octokit";

import type { GitHubAppFragmentConfig } from "./types";

type GitHubApiClientOptions = {
  fetch?: typeof fetch;
};

type OctokitAppInstance = InstanceType<typeof App>;
type GitHubOctokit = OctokitAppInstance["octokit"];

export type GitHubAppInstance = {
  octokit: GitHubOctokit;
  webhooks: OctokitAppInstance["webhooks"];
  getInstallationOctokit: (installationId: number) => Promise<GitHubOctokit>;
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

export type GitHubInstallationDetails = {
  id: string;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
  permissions: Record<string, unknown>;
  events: unknown[];
};

type GitHubInstallationRepositoriesResponse = {
  repositories: GitHubInstallationRepository[];
};

export type GitHubApiClient = {
  app: GitHubAppInstance;
  apiVersion: string;
  resolveInstallationId: (installationId: string) => number;
  getInstallation: (installationId: string) => Promise<GitHubInstallationDetails>;
  listInstallationRepos: (
    installationId: string,
  ) => Promise<GitHubInstallationRepositoriesResponse>;
  verifyWebhookSignature: (options: {
    payload: string;
    signatureHeader: string | null;
  }) => Promise<boolean>;
};

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2022-11-28";

export const createGitHubApiClient = (
  config: GitHubAppFragmentConfig,
  options: GitHubApiClientOptions = {},
): GitHubApiClient => {
  const fetchImpl = options.fetch ?? globalThis.fetch ?? undefined;
  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;

  const OctokitForApp = Octokit.defaults({
    baseUrl: apiBaseUrl,
    request: {
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      retries: 0,
    },
    headers: {
      "x-github-api-version": apiVersion,
    },
  });

  const octokitApp = new App({
    appId: config.appId,
    privateKey: config.privateKeyPem,
    webhooks: { secret: config.webhookSecret },
    Octokit: OctokitForApp,
  });
  const app: GitHubAppInstance = {
    octokit: octokitApp.octokit,
    webhooks: octokitApp.webhooks,
    getInstallationOctokit: async (installationId) =>
      await octokitApp.getInstallationOctokit(installationId),
  };

  const resolveInstallationId = (installationId: string) => {
    const numeric = Number.parseInt(installationId, 10);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(`Invalid installation id: ${installationId}`);
    }
    return numeric;
  };

  const getInstallationOctokit = async (installationId: string) => {
    return await octokitApp.getInstallationOctokit(resolveInstallationId(installationId));
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
      });
      const pageRepositories = response.data.repositories;
      repositories.push(...pageRepositories);

      const totalCount = response.data.total_count;
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

  const getInstallation = async (installationId: string): Promise<GitHubInstallationDetails> => {
    const response = await octokitApp.octokit.request("GET /app/installations/{installation_id}", {
      installation_id: resolveInstallationId(installationId),
    });

    const data = response.data;
    const account = data.account;
    if (!account || typeof account.id !== "number") {
      throw new Error("GitHub installation response is missing account information.");
    }

    const accountLogin =
      "login" in account && typeof account.login === "string" && account.login.length > 0
        ? account.login
        : "slug" in account && typeof account.slug === "string" && account.slug.length > 0
          ? account.slug
          : String(account.id);

    const accountType =
      "type" in account && typeof account.type === "string" && account.type.length > 0
        ? account.type
        : "login" in account
          ? "User"
          : "Enterprise";

    const status: GitHubInstallationDetails["status"] =
      typeof data.suspended_at === "string" && data.suspended_at.length > 0
        ? "suspended"
        : "active";

    return {
      id: typeof data.id === "number" ? String(data.id) : installationId,
      accountId: String(account.id),
      accountLogin,
      accountType,
      status,
      permissions: data.permissions ?? {},
      events: data.events ?? [],
    };
  };

  const verifyWebhookSignature = async (options: {
    payload: string;
    signatureHeader: string | null;
  }) => {
    if (!options.signatureHeader) {
      return false;
    }
    try {
      return await octokitApp.webhooks.verify(options.payload, options.signatureHeader);
    } catch {
      return false;
    }
  };

  return {
    app,
    apiVersion,
    resolveInstallationId,
    getInstallation,
    listInstallationRepos,
    verifyWebhookSignature,
  };
};
