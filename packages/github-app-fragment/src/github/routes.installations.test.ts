import { afterEach, beforeEach, describe, expect, it, assert, vi } from "vitest";

import { generateKeyPairSync } from "crypto";

import { drainDurableHooks } from "@fragno-dev/test";

import { githubAppSchema } from "../schema";
import { buildHarness, runGithubUowCreate } from "./test-utils";

type FetchCall = {
  url: URL;
  init?: RequestInit;
};

type SyncResponse =
  | { type: "json"; data: { added: number; removed: number; updated: number } }
  | { type: "error"; status: number; error: { code: string; message?: string } };

type InstallationsResponse =
  | { type: "json"; data: Array<{ id: string; status: string }> }
  | { type: "error"; error: { code: string; message?: string } };

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
  return privateKey.export({ type: "pkcs1", format: "pem" });
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

    const onRepositoryLinkStatusChanged = vi.fn();
    const fetchMock = createFetchMock({ installationId, repositories });
    globalThis.fetch = fetchMock;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
      onRepositoryLinkStatusChanged,
    });

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: installationId,
        accountId: "1",
        accountLogin: "stale-login",
        accountType: "User",
        status: "suspended",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
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

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
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

      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "303",
        linkKey: "default",
      });

      const response = await fragments.githubApp.callRoute(
        "POST",
        "/installations/:installationId/sync",
        { pathParams: { installationId } },
      );

      const typedResponse = response as SyncResponse;

      assert(typedResponse.type === "json");

      expect(typedResponse.data).toEqual({ added: 1, removed: 1, updated: 1 });

      const scopedRepos = (
        await fragments.githubApp.db
          .createUnitOfWork("read")
          .forSchema(githubAppSchema)
          .find("installation_repo", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];

      const repoById = new Map(scopedRepos.map((repo) => [toExternalId(repo.id), repo]));

      const newRepo = repoById.get("101");
      expect(newRepo).toBeTruthy();
      assert(newRepo?.fullName === "octo/new-repo");
      expect(newRepo?.removedAt).toBeNull();

      const updatedRepo = repoById.get("202");
      assert(updatedRepo?.name === "updated-repo");
      assert(updatedRepo?.fullName === "octo/updated-repo");
      assert(updatedRepo?.isPrivate);
      assert(updatedRepo?.defaultBranch === "develop");
      expect(updatedRepo?.removedAt).toBeNull();

      const removedRepo = repoById.get("303");
      expect(removedRepo).toBeTruthy();
      expect(removedRepo?.removedAt).not.toBeNull();

      const installations = (
        await fragments.githubApp.db
          .createUnitOfWork("read")
          .forSchema(githubAppSchema)
          .find("installation", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(installations).toHaveLength(1);
      assert(installations[0]?.accountLogin === "octo");
      assert(installations[0]?.status === "active");

      const repoLinks = (
        await fragments.githubApp.db
          .createUnitOfWork("read")
          .forSchema(githubAppSchema)
          .find("repo_link", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(repoLinks).toHaveLength(0);
      await drainDurableHooks(fragments.githubApp.fragment);
      expect(onRepositoryLinkStatusChanged.mock.calls.map(([payload]) => payload)).toEqual([
        {
          linkKey: "default",
          repositoryId: "303",
          fullName: "octo/removed-repo",
          status: "unlinked",
        },
      ]);

      assert(fetchMock.calls.length === 3);
      expect(fetchMock.calls[0]?.url.pathname).toBe(`/app/installations/${installationId}`);
      expect(fetchMock.calls[1]?.url.pathname).toContain("/access_tokens");
      assert(fetchMock.calls[2]?.url.pathname === "/installation/repositories");
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
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
    });

    try {
      const response = await fragments.githubApp.callRoute(
        "POST",
        "/installations/:installationId/sync",
        { pathParams: { installationId } },
      );

      const typedResponse = response as SyncResponse;
      assert(typedResponse.type === "json");

      expect(typedResponse.data).toEqual({ added: 1, removed: 0, updated: 0 });

      const installations = (
        await fragments.githubApp.db
          .createUnitOfWork("read")
          .forSchema(githubAppSchema)
          .find("installation", (b) => b.whereIndex("primary"))
          .executeRetrieve()
      )[0];
      expect(installations).toHaveLength(1);
      expect(toExternalId(installations[0]?.id)).toBe(installationId);
      assert(installations[0]?.accountLogin === "octo");

      assert(fetchMock.calls.length === 3);
      expect(fetchMock.calls[0]?.url.pathname).toBe(`/app/installations/${installationId}`);
      expect(fetchMock.calls[1]?.url.pathname).toContain("/access_tokens");
      assert(fetchMock.calls[2]?.url.pathname === "/installation/repositories");
    } finally {
      await test.cleanup();
    }
  });
});

describe("github-app installation sync races", () => {
  it("asks to sync again when another sync created the installation first", async () => {
    const installationId = "123";
    const repositories = [
      {
        id: 101,
        name: "api",
        full_name: "octo/api",
        private: false,
        fork: false,
        default_branch: "main",
        owner: { login: "octo" },
      },
    ];
    const fetchMock = createFetchMock({ installationId, repositories });
    // The first sync waits on GitHub for its installation until the test lets it continue.
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedGitHub: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      reachedGitHub = resolve;
    });
    let installationReads = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === `/app/installations/${installationId}`) {
        installationReads += 1;
        if (installationReads === 1) {
          reachedGitHub();
          await released;
        }
      }
      return await fetchMock(input, init);
    }) as typeof fetch;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
    });

    try {
      const sync = () =>
        fragments.githubApp.callRoute("POST", "/installations/:installationId/sync", {
          pathParams: { installationId },
        }) as Promise<SyncResponse>;

      // Both syncs read before either writes, so both find no installation.
      const first = sync();
      await waiting;
      const second = await sync();
      assert(second.type === "json");
      expect(second.data).toEqual({ added: 1, removed: 0, updated: 0 });

      // The first sync read before the second wrote, so its write conflicts and it asks for
      // another sync instead of failing on the duplicate.
      release();
      const conflicted = await first;
      assert(
        conflicted.type === "error" &&
          conflicted.status === 409 &&
          conflicted.error.code === "INSTALLATION_SYNC_CONFLICT",
      );
      // Syncing again reads what the other sync created, so nothing changes.
      const again = await sync();
      assert(again.type === "json");
      expect(again.data).toEqual({ added: 0, removed: 0, updated: 0 });

      const read = async <T extends "installation" | "installation_repo">(table: T) =>
        (
          await fragments.githubApp.db
            .createUnitOfWork("read")
            .forSchema(githubAppSchema)
            .find(table, (b) => b.whereIndex("primary"))
            .executeRetrieve()
        )[0];
      expect((await read("installation")).map(({ id }) => toExternalId(id))).toEqual([
        installationId,
      ]);
      expect((await read("installation_repo")).map(({ fullName }) => fullName)).toEqual([
        "octo/api",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await test.cleanup();
    }
  });
});

describe("github-app installation release races", () => {
  it("a sync that read before the release cannot write the installation back", async () => {
    const installationId = "123";
    const fetchMock = createFetchMock({
      installationId,
      repositories: [
        {
          id: 101,
          name: "api",
          full_name: "octo/api",
          private: false,
          fork: false,
          default_branch: "main",
          owner: { login: "octo" },
        },
      ],
    });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedGitHub: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      reachedGitHub = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === `/app/installations/${installationId}`) {
        reachedGitHub();
        await released;
      }
      return await fetchMock(input, init);
    }) as typeof fetch;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
    });

    try {
      const sync = () =>
        fragments.githubApp.callRoute("POST", "/installations/:installationId/sync", {
          pathParams: { installationId },
        }) as Promise<SyncResponse>;

      // The sync reads no installation, then waits on GitHub while the store releases it.
      const inFlight = sync();
      await waiting;
      const releasing = (await fragments.githubApp.callRoute(
        "POST",
        "/installations/:installationId/release",
        {
          pathParams: { installationId },
          // The store has no row for it yet.
          body: { accountId: "1", accountLogin: "octo", accountType: "User", version: null },
        },
      )) as { type: "json"; data: { released: boolean } };
      expect(releasing.data).toEqual({ released: true });

      release();
      const conflicted = await inFlight;
      assert(conflicted.type === "error" && conflicted.error.code === "INSTALLATION_SYNC_CONFLICT");
      // Syncing again reads the release.
      const again = await sync();
      assert(again.type === "error" && again.error.code === "INSTALLATION_RELEASED");

      const [installations] = await fragments.githubApp.db
        .createUnitOfWork("read")
        .forSchema(githubAppSchema)
        .find("installation", (b) => b.whereIndex("primary"))
        .executeRetrieve();
      expect(installations.map(({ status }) => status)).toEqual(["deleted"]);
    } finally {
      globalThis.fetch = originalFetch;
      await test.cleanup();
    }
  });
});

describe("github-app installation release", () => {
  it("forgets an installation and unlinks its repositories without asking GitHub", async () => {
    const installationId = "123";
    const onRepositoryLinkStatusChanged = vi.fn();
    const fetchMock = createFetchMock({ installationId, repositories: [] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
      onRepositoryLinkStatusChanged,
    });

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: installationId,
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });
      for (const [id, name] of [
        ["101", "linked"],
        ["102", "unlinked"],
      ] as const) {
        await runGithubUowCreate(fragments.githubApp.db, "seed", "installation_repo", {
          id,
          installationId,
          ownerLogin: "octo",
          name,
          fullName: `octo/${name}`,
          isPrivate: false,
          isFork: false,
          defaultBranch: "main",
          removedAt: null,
        });
      }
      await runGithubUowCreate(fragments.githubApp.db, "seed", "repo_link", {
        repoId: "101",
        linkKey: "default",
      });

      const release = async () => {
        const read = (await fragments.githubApp.callRoute("GET", "/installations/:installationId", {
          pathParams: { installationId },
        })) as { type: "json"; data: { version: number } };
        return (await fragments.githubApp.callRoute(
          "POST",
          "/installations/:installationId/release",
          {
            pathParams: { installationId },
            body: {
              accountId: "1",
              accountLogin: "octo",
              accountType: "User",
              version: read.data.version,
            },
          },
        )) as { type: "json"; data: { released: boolean } };
      };
      expect((await release()).data).toEqual({ released: true });

      const read = async <T extends "installation" | "installation_repo" | "repo_link">(table: T) =>
        (
          await fragments.githubApp.db
            .createUnitOfWork("read")
            .forSchema(githubAppSchema)
            .find(table, (b) => b.whereIndex("primary"))
            .executeRetrieve()
        )[0];
      expect((await read("installation")).map(({ status }) => status)).toEqual(["deleted"]);
      assert((await read("installation_repo")).every(({ removedAt }) => removedAt !== null));
      expect(await read("repo_link")).toEqual([]);
      await drainDurableHooks(fragments.githubApp.fragment);
      expect(onRepositoryLinkStatusChanged.mock.calls.map(([payload]) => payload)).toEqual([
        { linkKey: "default", repositoryId: "101", fullName: "octo/linked", status: "unlinked" },
      ]);

      // Released once; GitHub is never asked, since it keeps the installation.
      expect((await release()).data).toEqual({ released: false });
      expect(fetchMock.calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      await test.cleanup();
    }
  });
});

describe("github-app installation listing", () => {
  it("filters installations by status", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
    });

    try {
      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
        id: "1",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await runGithubUowCreate(fragments.githubApp.db, "seed", "installation", {
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

      assert(response.type === "json");

      expect(response.data).toHaveLength(1);
      assert(response.data[0]?.id === "1");
      assert(response.data[0]?.status === "active");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects invalid status filters", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
      webhookDeliveryRetentionMs: 60_000,
    });

    try {
      const response = (await fragments.githubApp.callRoute("GET", "/installations", {
        query: { status: "unknown" },
      })) as InstallationsResponse;

      assert(response.type === "error");

      assert(response.error.code === "INVALID_STATUS");
    } finally {
      await test.cleanup();
    }
  });
});
