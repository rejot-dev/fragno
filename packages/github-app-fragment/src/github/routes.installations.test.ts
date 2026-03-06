import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "crypto";

import { buildHarness } from "./test-utils";

type FetchCall = {
  url: URL;
  init?: RequestInit;
};

type SyncResponse =
  | { type: "json"; data: { added: number; removed: number; updated: number } }
  | { type: "error"; error: { code: string; message?: string } };

type InstallationsResponse =
  | { type: "json"; data: Array<{ id: string; status: string }> }
  | { type: "error"; error: { code: string; message?: string } };

type InstallationRepoRow = {
  id: { valueOf: () => string } | string;
  name?: string | null;
  fullName?: string | null;
  isPrivate?: boolean | null;
  defaultBranch?: string | null;
  removedAt?: Date | null;
};

type RepoLinkRow = {
  id: { valueOf: () => string } | string;
  repoId?: string | null;
};

const toExternalId = (value: unknown) => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return `${value}`;
  }
  if (typeof value === "object" && value && "valueOf" in value) {
    const valueOf = (value as { valueOf?: () => unknown }).valueOf;
    if (typeof valueOf === "function") {
      const result = valueOf.call(value);
      if (typeof result === "string") {
        return result;
      }
    }
  }
  return "";
};

const createFetchMock = (options: {
  installationId: string;
  repositories: Array<Record<string, unknown>>;
}) => {
  const calls: FetchCall[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);

    calls.push({ url, init });

    if (url.pathname === `/app/installations/${options.installationId}/access_tokens`) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === `/app/installations/${options.installationId}`) {
      return new Response(
        JSON.stringify({
          id: Number(options.installationId),
          account: { id: 1, login: "octo", type: "User" },
          permissions: {},
          events: [],
          suspended_at: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === "/installation/repositories") {
      return new Response(JSON.stringify({ repositories: options.repositories }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };

  return Object.assign(fetchMock, { calls });
};

const createPrivateKey = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
};

describe("github-app installation sync", () => {
  const installationId = "123";
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    const originalFetch = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it("syncs repositories and reconciles links", async () => {
    const repositories = [
      {
        id: 101,
        name: "new-repo",
        full_name: "octo/new-repo",
        private: false,
        fork: false,
        default_branch: "main",
        owner: { login: "octo" },
      },
      {
        id: 202,
        name: "updated-repo",
        full_name: "octo/updated-repo",
        private: true,
        fork: false,
        default_branch: "develop",
        owner: { login: "octo" },
      },
    ];

    const fetchMock = createFetchMock({ installationId, repositories });
    globalThis.fetch = fetchMock;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: installationId,
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "202",
        installationId,
        ownerLogin: "octo",
        name: "old-name",
        fullName: "octo/old-name",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "303",
        installationId,
        ownerLogin: "octo",
        name: "removed-repo",
        fullName: "octo/removed-repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "303",
        linkKey: "default",
      });

      const response = await fragments.githubApp.callRoute(
        "POST",
        "/installations/:installationId/sync",
        { pathParams: { installationId } },
      );

      const typedResponse = response as SyncResponse;

      expect(typedResponse.type).toBe("json");
      if (typedResponse.type !== "json") {
        throw new Error(`Expected json response, got ${typedResponse.type}`);
      }

      expect(typedResponse.data).toEqual({ added: 1, removed: 1, updated: 1 });

      const scopedRepos = (await fragments.githubApp.db.find(
        "installation_repo",
      )) as InstallationRepoRow[];

      const repoById = new Map(scopedRepos.map((repo) => [toExternalId(repo.id), repo]));

      const newRepo = repoById.get("101");
      expect(newRepo).toBeTruthy();
      expect(newRepo?.fullName).toBe("octo/new-repo");
      expect(newRepo?.removedAt).toBeNull();

      const updatedRepo = repoById.get("202");
      expect(updatedRepo?.name).toBe("updated-repo");
      expect(updatedRepo?.fullName).toBe("octo/updated-repo");
      expect(updatedRepo?.isPrivate).toBe(true);
      expect(updatedRepo?.defaultBranch).toBe("develop");
      expect(updatedRepo?.removedAt).toBeNull();

      const removedRepo = repoById.get("303");
      expect(removedRepo).toBeTruthy();
      expect(removedRepo?.removedAt).not.toBeNull();

      const repoLinks = (await fragments.githubApp.db.find("repo_link")) as RepoLinkRow[];
      expect(repoLinks).toHaveLength(0);

      expect(fetchMock.calls.length).toBe(2);
      expect(fetchMock.calls[0]?.url.pathname).toContain("/access_tokens");
      expect(fetchMock.calls[1]?.url.pathname).toBe("/installation/repositories");
    } finally {
      await test.cleanup();
    }
  });

  it("bootstraps installation from GitHub before syncing repositories", async () => {
    const repositories = [
      {
        id: 101,
        name: "new-repo",
        full_name: "octo/new-repo",
        private: false,
        fork: false,
        default_branch: "main",
        owner: { login: "octo" },
      },
    ];

    const fetchMock = createFetchMock({ installationId, repositories });
    globalThis.fetch = fetchMock;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = await fragments.githubApp.callRoute(
        "POST",
        "/installations/:installationId/sync",
        { pathParams: { installationId } },
      );

      const typedResponse = response as SyncResponse;
      expect(typedResponse.type).toBe("json");
      if (typedResponse.type !== "json") {
        throw new Error(`Expected json response, got ${typedResponse.type}`);
      }

      expect(typedResponse.data).toEqual({ added: 1, removed: 0, updated: 0 });

      const installations = (await fragments.githubApp.db.find("installation")) as Array<{
        id: { valueOf: () => string } | string;
        accountLogin?: string | null;
      }>;
      expect(installations).toHaveLength(1);
      expect(toExternalId(installations[0]?.id)).toBe(installationId);
      expect(installations[0]?.accountLogin).toBe("octo");

      expect(fetchMock.calls.length).toBe(3);
      expect(fetchMock.calls[0]?.url.pathname).toBe(`/app/installations/${installationId}`);
      expect(fetchMock.calls[1]?.url.pathname).toContain("/access_tokens");
      expect(fetchMock.calls[2]?.url.pathname).toBe("/installation/repositories");
    } finally {
      await test.cleanup();
    }
  });
});

describe("github-app installation listing", () => {
  it("filters installations by status", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation", {
        id: "2",
        accountId: "2",
        accountLogin: "hubot",
        accountType: "User",
        status: "suspended",
        permissions: {},
        events: [],
      });

      const response = (await fragments.githubApp.callRoute("GET", "/installations", {
        query: { status: "active" },
      })) as InstallationsResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data).toHaveLength(1);
      expect(response.data[0]?.id).toBe("1");
      expect(response.data[0]?.status).toBe("active");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects invalid status filters", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute("GET", "/installations", {
        query: { status: "unknown" },
      })) as InstallationsResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INVALID_STATUS");
    } finally {
      await test.cleanup();
    }
  });
});
