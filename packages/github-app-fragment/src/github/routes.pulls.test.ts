import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateKeyPairSync } from "crypto";

import { buildHarness } from "./test-utils";

type FetchCall = {
  url: URL;
  init?: RequestInit;
};

type PullsResponse =
  | {
      type: "json";
      data: { pulls: Array<Record<string, unknown>>; pageInfo: { page: number; perPage: number } };
    }
  | { type: "error"; error: { code: string; message?: string } };

type ReviewResponse =
  | { type: "json"; data: { review: Record<string, unknown> } }
  | { type: "error"; error: { code: string; message?: string } };

type ErrorResponse = { type: "error"; error: { code: string; message?: string } };

const createPrivateKey = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
};

const createFetchMock = (options: {
  installationId: string;
  pulls: Array<Record<string, unknown>>;
  review: Record<string, unknown>;
  pullsStatus?: number;
  reviewStatus?: number;
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

    if (url.pathname === "/repos/octo/repo/pulls") {
      const status = options.pullsStatus ?? 200;
      const body = status >= 400 ? { message: "GitHub error" } : options.pulls;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/repos/octo/repo/pulls/12/reviews") {
      const status = options.reviewStatus ?? 200;
      const body = status >= 400 ? { message: "GitHub error" } : options.review;
      return new Response(JSON.stringify(body), {
        status,
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

describe("github-app pull request routes", () => {
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

  it("rejects invalid state filters", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" }, query: { state: "invalid" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INVALID_STATE");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects invalid perPage values", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" }, query: { perPage: "0" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INVALID_PER_PAGE");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects invalid page values", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" }, query: { page: "0" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INVALID_PAGE");
    } finally {
      await test.cleanup();
    }
  });

  it("lists pull requests for linked repositories", async () => {
    const installationId = "55";
    const fetchMock = createFetchMock({
      installationId,
      pulls: [{ id: 1, title: "Test PR" }],
      review: { id: 99 },
    });
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
        id: "100",
        installationId,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "100",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        {
          pathParams: { owner: "octo", repo: "repo" },
          query: { perPage: "25", page: "2" },
        },
      )) as PullsResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data.pulls).toHaveLength(1);
      expect(response.data.pageInfo).toEqual({ page: 2, perPage: 25 });

      const pullsCall = fetchMock.calls.find(
        (call) => call.url.pathname === "/repos/octo/repo/pulls",
      );
      expect(pullsCall?.url.searchParams.get("per_page")).toBe("25");
      expect(pullsCall?.url.searchParams.get("page")).toBe("2");
    } finally {
      await test.cleanup();
    }
  });

  it("lists pull requests when linked under a non-default link key", async () => {
    const installationId = "56";
    const fetchMock = createFetchMock({
      installationId,
      pulls: [{ id: 2, title: "Alpha PR" }],
      review: { id: 199 },
    });
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
        id: "101",
        installationId,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "101",
        linkKey: "alpha",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as PullsResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data.pulls).toHaveLength(1);
      expect(response.data.pulls[0]).toMatchObject({ id: 2, title: "Alpha PR" });
    } finally {
      await test.cleanup();
    }
  });

  it("rejects pull request queries when repo is missing", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects pull request queries for removed repos", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "9",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "90",
        installationId: "9",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: new Date(),
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_REMOVED");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects pull request queries for unlinked repos", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "10",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "100",
        installationId: "10",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_NOT_LINKED");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects pull request queries when installation is inactive", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "11",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "suspended",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "110",
        installationId: "11",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "110",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_INACTIVE");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects pull request queries when installation is missing", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation_repo", {
        id: "120",
        installationId: 999n,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("maps GitHub API errors for pull request queries", async () => {
    const installationId = "13";
    const fetchMock = createFetchMock({
      installationId,
      pulls: [],
      review: { id: 1 },
      pullsStatus: 500,
    });
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
        id: "130",
        installationId,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "130",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "GET",
        "/repositories/:owner/:repo/pulls",
        { pathParams: { owner: "octo", repo: "repo" } },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("GITHUB_API_ERROR");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects review requests with invalid pull numbers", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "0" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INVALID_PULL_NUMBER");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects review requests when repo is missing", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "12" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects review requests for removed repos", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "14",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "140",
        installationId: "14",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: new Date(),
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "12" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_REMOVED");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects review requests for unlinked repos", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "15",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "150",
        installationId: "15",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "12" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("REPO_NOT_LINKED");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects review requests when installation is inactive", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation", {
        id: "16",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "suspended",
        permissions: {},
        events: [],
      });

      await fragments.githubApp.db.create("installation_repo", {
        id: "160",
        installationId: "16",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "160",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "12" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_INACTIVE");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects review requests when installation is missing", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: "secret",
    });

    try {
      await fragments.githubApp.db.create("installation_repo", {
        id: "170",
        installationId: 1000n,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "12" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("INSTALLATION_NOT_FOUND");
    } finally {
      await test.cleanup();
    }
  });

  it("maps GitHub API errors for pull request reviews", async () => {
    const installationId = "18";
    const fetchMock = createFetchMock({
      installationId,
      pulls: [],
      review: { id: 1 },
      reviewStatus: 500,
    });
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
        id: "180",
        installationId,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "180",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        { pathParams: { owner: "octo", repo: "repo", number: "12" }, body: {} },
      )) as ErrorResponse;

      expect(response.type).toBe("error");
      if (response.type !== "error") {
        throw new Error(`Expected error response, got ${response.type}`);
      }

      expect(response.error.code).toBe("GITHUB_API_ERROR");
    } finally {
      await test.cleanup();
    }
  });

  it("creates pull request reviews for linked repositories", async () => {
    const installationId = "77";
    const fetchMock = createFetchMock({
      installationId,
      pulls: [],
      review: { id: 123, state: "approved" },
    });
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
        id: "200",
        installationId,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "200",
        linkKey: "default",
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        {
          pathParams: { owner: "octo", repo: "repo", number: "12" },
          body: { event: "APPROVE", body: "Looks good" },
        },
      )) as ReviewResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data.review).toMatchObject({ id: 123, state: "approved" });

      const reviewCall = fetchMock.calls.find(
        (call) => call.url.pathname === "/repos/octo/repo/pulls/12/reviews",
      );
      const body = reviewCall?.init?.body;
      expect(typeof body).toBe("string");
      if (typeof body === "string") {
        expect(JSON.parse(body)).toMatchObject({ event: "APPROVE", body: "Looks good" });
      }
    } finally {
      await test.cleanup();
    }
  });

  it("creates pull request reviews when linked under a non-default link key", async () => {
    const installationId = "78";
    const fetchMock = createFetchMock({
      installationId,
      pulls: [],
      review: { id: 124, state: "approved" },
    });
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
        id: "201",
        installationId,
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });

      await fragments.githubApp.db.create("repo_link", {
        repoId: "201",
        linkKey: "alpha",
      });

      const response = (await fragments.githubApp.callRoute(
        "POST",
        "/repositories/:owner/:repo/pulls/:number/reviews",
        {
          pathParams: { owner: "octo", repo: "repo", number: "12" },
          body: { event: "APPROVE", body: "Looks good" },
        },
      )) as ReviewResponse;

      expect(response.type).toBe("json");
      if (response.type !== "json") {
        throw new Error(`Expected json response, got ${response.type}`);
      }

      expect(response.data.review).toMatchObject({ id: 124, state: "approved" });
    } finally {
      await test.cleanup();
    }
  });
});
