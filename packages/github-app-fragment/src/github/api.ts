import { App, Octokit } from "octokit";

import type { GitHubAppFragmentConfig } from "./types";

type GitHubApiClientOptions = {
  fetch?: typeof fetch;
};

type OctokitAppInstance = InstanceType<typeof App>;
type GitHubOctokit = OctokitAppInstance["octokit"];
type InstallationResponse = Awaited<
  ReturnType<GitHubOctokit["rest"]["apps"]["getInstallation"]>
>["data"];
type UserInstallationResponse = Awaited<
  ReturnType<GitHubOctokit["rest"]["apps"]["listInstallationsForAuthenticatedUser"]>
>["data"]["installations"][number];

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

export type GitHubUserInstallation = {
  id: string;
  accountId: string;
  accountLogin: string;
  accountType: string;
  appId: string;
  appSlug: string;
  repositorySelection: string;
  permissions: Record<string, unknown>;
  events: unknown[];
  htmlUrl: string | null;
  status: "active" | "suspended";
};

export type GitHubUserAuthorizationToken = {
  accessToken: string;
  tokenType: string | null;
  scopes: string | null;
};

export type GitHubUserProfile = {
  id: string;
  login: string;
};

export type GitHubApiClient = {
  app: GitHubAppInstance;
  apiVersion: string;
  resolveInstallationId: (installationId: string) => number;
  createUserAuthorizationUrl: (options?: { state?: string }) => string;
  exchangeUserAuthorizationCode: (options: {
    code: string;
    state?: string;
  }) => Promise<GitHubUserAuthorizationToken>;
  getUserProfile: (accessToken: string) => Promise<GitHubUserProfile>;
  listUserInstallations: (
    accessToken: string,
  ) => Promise<{ installations: GitHubUserInstallation[] }>;
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

const getAccountLogin = (account: InstallationResponse["account"]) => {
  if (!account) {
    return "";
  }
  if ("login" in account && typeof account.login === "string" && account.login.length > 0) {
    return account.login;
  }
  if ("slug" in account && typeof account.slug === "string" && account.slug.length > 0) {
    return account.slug;
  }
  return String(account.id);
};

const getAccountType = (account: InstallationResponse["account"]) => {
  if (!account) {
    return "Unknown";
  }
  if ("type" in account && typeof account.type === "string" && account.type.length > 0) {
    return account.type;
  }
  return "login" in account ? "User" : "Enterprise";
};

const getInstallationStatus = (suspendedAt: string | null | undefined) =>
  suspendedAt ? "suspended" : "active";

const toUserInstallation = (installation: UserInstallationResponse): GitHubUserInstallation => ({
  id: String(installation.id),
  accountId: String(installation.account?.id ?? ""),
  accountLogin: getAccountLogin(installation.account),
  accountType: getAccountType(installation.account),
  appId: String(installation.app_id),
  appSlug: installation.app_slug,
  repositorySelection: installation.repository_selection,
  permissions: installation.permissions ?? {},
  events: installation.events ?? [],
  htmlUrl: installation.html_url ?? null,
  status: getInstallationStatus(installation.suspended_at),
});

const toInstallationDetails = (
  installation: InstallationResponse,
  fallbackId: string,
): GitHubInstallationDetails => {
  const account = installation.account;
  if (!account || typeof account.id !== "number") {
    throw new Error("GitHub installation response is missing account information.");
  }

  return {
    id: typeof installation.id === "number" ? String(installation.id) : fallbackId,
    accountId: String(account.id),
    accountLogin: getAccountLogin(account),
    accountType: getAccountType(account),
    status: getInstallationStatus(installation.suspended_at),
    permissions: installation.permissions ?? {},
    events: installation.events ?? [],
  };
};

const rewriteUrlOrigin = (url: string, origin: string | undefined) => {
  if (!origin) {
    return url;
  }
  const rewritten = new URL(url);
  const base = new URL(origin);
  rewritten.protocol = base.protocol;
  rewritten.host = base.host;
  return rewritten.toString();
};

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
    oauth: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
    Octokit: OctokitForApp,
  });
  const app: GitHubAppInstance = {
    octokit: octokitApp.octokit,
    webhooks: octokitApp.webhooks,
    getInstallationOctokit: async (installationId) => {
      return await octokitApp.getInstallationOctokit(installationId);
    },
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

  const getUserOctokit = async (accessToken: string) => {
    return await octokitApp.oauth.getUserOctokit({ token: accessToken });
  };

  const createUserAuthorizationUrl = (options: { state?: string } = {}) => {
    const { url } = octokitApp.oauth.getWebFlowAuthorizationUrl({
      redirectUrl: config.callbackUrl,
      ...(options.state ? { state: options.state } : {}),
    });
    return rewriteUrlOrigin(url, config.webBaseUrl);
  };

  const exchangeUserAuthorizationCode = async (options: { code: string; state?: string }) => {
    const { authentication } = await octokitApp.oauth.createToken({
      code: options.code,
      redirectUrl: config.callbackUrl,
      ...(options.state ? { state: options.state } : {}),
    });

    return {
      accessToken: authentication.token,
      tokenType: authentication.tokenType ?? null,
      scopes: null,
    } satisfies GitHubUserAuthorizationToken;
  };

  const getUserProfile = async (accessToken: string) => {
    const userOctokit = await getUserOctokit(accessToken);
    const { data } = await userOctokit.rest.users.getAuthenticated();

    return {
      id: String(data.id),
      login: data.login,
    } satisfies GitHubUserProfile;
  };

  const listUserInstallations = async (accessToken: string) => {
    const userOctokit = await getUserOctokit(accessToken);
    const installations: GitHubUserInstallation[] = [];
    const perPage = 100;
    let page = 1;

    while (true) {
      const { data } = await userOctokit.rest.apps.listInstallationsForAuthenticatedUser({
        page,
        per_page: perPage,
      });
      installations.push(...data.installations.map(toUserInstallation));

      if (data.installations.length === 0) {
        break;
      }
      if (installations.length >= data.total_count) {
        break;
      }
      if (data.installations.length < perPage) {
        break;
      }
      page += 1;
    }

    return { installations };
  };

  const listInstallationRepos = async (installationId: string) => {
    const installationOctokit = await getInstallationOctokit(installationId);
    const repositories: GitHubInstallationRepository[] = [];
    const perPage = 100;
    let page = 1;

    while (true) {
      const { data } = await installationOctokit.rest.apps.listReposAccessibleToInstallation({
        page,
        per_page: perPage,
      });
      repositories.push(...data.repositories);

      if (data.repositories.length === 0) {
        break;
      }
      if (repositories.length >= data.total_count) {
        break;
      }
      if (data.repositories.length < perPage) {
        break;
      }
      page += 1;
    }

    return { repositories } satisfies GitHubInstallationRepositoriesResponse;
  };

  const getInstallation = async (installationId: string): Promise<GitHubInstallationDetails> => {
    const { data } = await octokitApp.octokit.rest.apps.getInstallation({
      installation_id: resolveInstallationId(installationId),
    });
    return toInstallationDetails(data, installationId);
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
    createUserAuthorizationUrl,
    exchangeUserAuthorizationCode,
    getUserProfile,
    listUserInstallations,
    getInstallation,
    listInstallationRepos,
    verifyWebhookSignature,
  };
};
