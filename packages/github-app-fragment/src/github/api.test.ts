import { describe, expect, it, vi } from "vitest";

import { createHmac, generateKeyPairSync } from "crypto";

import { createGitHubApiClient } from "./api";

type FetchCall = {
  url: URL;
  init?: RequestInit;
};

const createPrivateKey = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
};

const createFetchMock = (handlers: {
  repositories?: Array<Record<string, unknown>>;
  repositoriesByPage?: Array<Array<Record<string, unknown>>>;
  pulls?: Array<Record<string, unknown>>;
  review?: Record<string, unknown>;
  deliveries?: Array<Record<string, unknown>>;
}) => {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);

    calls.push({ url, init });

    if (url.pathname.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname.endsWith("/installation/repositories")) {
      if (handlers.repositoriesByPage) {
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
        const repositories = handlers.repositoriesByPage[page - 1] ?? [];
        const totalCount = handlers.repositoriesByPage.reduce(
          (sum, pageRepositories) => sum + pageRepositories.length,
          0,
        );
        return new Response(JSON.stringify({ repositories, total_count: totalCount }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ repositories: handlers.repositories ?? [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.endsWith("/repos/octo/repo/pulls")) {
      return new Response(JSON.stringify(handlers.pulls ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.endsWith("/repos/octo/repo/pulls/12/reviews")) {
      return new Response(JSON.stringify(handlers.review ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname.endsWith("/app/hook/deliveries")) {
      return new Response(JSON.stringify(handlers.deliveries ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (/\/app\/hook\/deliveries\/\d+\/attempts$/.test(url.pathname)) {
      return new Response(null, { status: 202 });
    }

    return new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });

  return { fetchMock, calls };
};

describe("createGitHubApiClient", () => {
  it("uses octokit app auth to list installation repositories", async () => {
    const { fetchMock, calls } = createFetchMock({
      repositories: [{ id: 1, name: "repo", full_name: "octo/repo", owner: { login: "octo" } }],
    });

    const client = createGitHubApiClient(
      {
        appId: "42",
        appSlug: "test-app",
        privateKeyPem: createPrivateKey(),
        webhookSecret: "secret",
        apiBaseUrl: "https://github.company.com/api/v3",
      },
      { fetch: fetchMock },
    );

    const response = await client.listInstallationRepos("123");
    expect(response.repositories).toHaveLength(1);

    const tokenCall = calls.find((call) => call.url.pathname.endsWith("/access_tokens"));
    const reposCall = calls.find((call) =>
      call.url.pathname.endsWith("/installation/repositories"),
    );

    expect(tokenCall?.url.pathname).toBe("/api/v3/app/installations/123/access_tokens");
    expect(reposCall?.url.pathname).toBe("/api/v3/installation/repositories");
    expect(reposCall?.url.searchParams.get("per_page")).toBe("100");
  });

  it("exposes app and installation octokit for direct requests", async () => {
    const { fetchMock, calls } = createFetchMock({
      pulls: [{ id: 99, title: "Test PR" }],
      review: { id: 77, state: "COMMENTED" },
    });

    const client = createGitHubApiClient(
      {
        appId: "42",
        appSlug: "test-app",
        privateKeyPem: createPrivateKey(),
        webhookSecret: "secret",
      },
      { fetch: fetchMock },
    );

    const installationOctokit = await client.app.getInstallationOctokit(
      client.resolveInstallationId("123"),
    );
    const pullsResponse = await installationOctokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner: "octo",
      repo: "repo",
      state: "open",
      per_page: 25,
      page: 2,
    });
    expect(pullsResponse.data).toHaveLength(1);

    const reviewResponse = await installationOctokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner: "octo",
        repo: "repo",
        pull_number: 12,
        event: "COMMENT",
        body: "Looks good",
        commit_id: "abc123",
      },
    );
    expect(reviewResponse.data).toMatchObject({ id: 77 });

    const pullsCall = calls.find((call) => call.url.pathname === "/repos/octo/repo/pulls");
    expect(pullsCall?.url.searchParams.get("state")).toBe("open");
    expect(pullsCall?.url.searchParams.get("per_page")).toBe("25");
    expect(pullsCall?.url.searchParams.get("page")).toBe("2");

    const reviewCall = calls.find(
      (call) => call.url.pathname === "/repos/octo/repo/pulls/12/reviews",
    );
    const reviewPayload = JSON.parse((reviewCall?.init?.body as string | undefined) ?? "{}") as {
      event?: string;
      body?: string;
      commit_id?: string;
    };
    expect(reviewPayload).toMatchObject({
      event: "COMMENT",
      body: "Looks good",
      commit_id: "abc123",
    });

    const hookDeliveriesResponse = await client.app.octokit.request("GET /app/hook/deliveries", {
      per_page: 25,
    });
    expect(hookDeliveriesResponse.data).toEqual([]);

    await client.app.octokit.request("POST /app/hook/deliveries/{delivery_id}/attempts", {
      delivery_id: 12345,
    });

    const deliveriesCall = calls.find((call) => call.url.pathname === "/app/hook/deliveries");
    expect(deliveriesCall?.url.searchParams.get("per_page")).toBe("25");

    const redeliverCall = calls.find((call) =>
      call.url.pathname.endsWith("/app/hook/deliveries/12345/attempts"),
    );
    expect(redeliverCall).toBeDefined();
  });

  it("paginates installation repositories", async () => {
    const repositoriesByPage = [
      Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        name: `repo-${index + 1}`,
        full_name: `octo/repo-${index + 1}`,
        owner: { login: "octo" },
      })),
      [{ id: 101, name: "repo-101", full_name: "octo/repo-101", owner: { login: "octo" } }],
    ];
    const { fetchMock, calls } = createFetchMock({ repositoriesByPage });

    const client = createGitHubApiClient(
      {
        appId: "42",
        appSlug: "test-app",
        privateKeyPem: createPrivateKey(),
        webhookSecret: "secret",
      },
      { fetch: fetchMock },
    );

    const response = await client.listInstallationRepos("123");
    expect(response.repositories).toHaveLength(101);
    expect(response.repositories[0]).toMatchObject({ id: 1 });
    expect(response.repositories[100]).toMatchObject({ id: 101 });

    const repoCalls = calls.filter((call) =>
      call.url.pathname.endsWith("/installation/repositories"),
    );
    expect(repoCalls).toHaveLength(2);
    expect(repoCalls[0]?.url.searchParams.get("page")).toBe("1");
    expect(repoCalls[1]?.url.searchParams.get("page")).toBe("2");
  });

  it("verifies webhook signatures using octokit webhooks", async () => {
    const secret = "secret";
    const payload = JSON.stringify({ action: "created", installation: { id: 1 } });
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

    const client = createGitHubApiClient({
      appId: "42",
      appSlug: "test-app",
      privateKeyPem: createPrivateKey(),
      webhookSecret: secret,
    });

    await expect(
      client.verifyWebhookSignature({ payload, signatureHeader: signature }),
    ).resolves.toBe(true);
    await expect(
      client.verifyWebhookSignature({ payload, signatureHeader: "sha256=bad" }),
    ).resolves.toBe(false);
    await expect(client.verifyWebhookSignature({ payload, signatureHeader: null })).resolves.toBe(
      false,
    );
  });
});
