import { describe, expect, it, assert } from "vitest";

import { generateKeyPairSync } from "crypto";

import { buildHarness, runGithubUowCreate } from "./test-utils";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pathParams = { owner: "octo", repo: "repo" };

describe("github-app repository API route", () => {
  it("proxies repository-relative requests with a token restricted to that repository", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body: text ? JSON.parse(text) : null,
      });
      if (url.pathname === "/app/installations/58/access_tokens") {
        return Response.json(
          { token: "repo-token", expires_at: "2099-01-01T00:00:00Z" },
          { status: 201 },
        );
      }
      assert(request.headers.get("authorization") === "token repo-token");
      if (url.pathname === "/repos/octo/repo/issues" && request.method === "GET") {
        return Response.json([{ number: 1 }], {
          headers: { link: '<https://api.github.com/repos/octo/repo/issues?page=2>; rel="next"' },
        });
      }
      if (url.pathname === "/repos/octo/repo/issues/1/comments") {
        return Response.json({ id: 5, body: "hi" }, { status: 201 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    };
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
      webhookSecret: "secret",
      fetch: fetchMock,
    });
    const { callRoute, db } = fragments.githubApp;
    const request = (body: Record<string, unknown>) =>
      callRoute("POST", "/repositories/:owner/:repo/api", {
        pathParams,
        body: { query: {}, body: null, ...body },
      });

    try {
      await runGithubUowCreate(db, "install", "installation", {
        id: "58",
        accountId: "1",
        accountLogin: "octo",
        accountType: "User",
        status: "active",
        permissions: {},
        events: [],
      });
      await runGithubUowCreate(db, "grant", "installation_repo", {
        id: "10",
        installationId: "58",
        ownerLogin: "octo",
        name: "repo",
        fullName: "octo/repo",
        isPrivate: false,
        isFork: false,
        defaultBranch: "main",
        removedAt: null,
      });
      expect(await request({ method: "GET", path: "/issues" })).toMatchObject({
        type: "error",
        error: { code: "REPO_NOT_LINKED" },
      });

      await callRoute("POST", "/repositories/:owner/:repo/link", { pathParams, body: {} });
      expect(
        await request({ method: "GET", path: "/issues", query: { state: "open" } }),
      ).toMatchObject({
        type: "json",
        data: {
          status: 200,
          body: [{ number: 1 }],
          headers: { link: expect.stringContaining('rel="next"') },
        },
      });
      expect(
        await request({ method: "POST", path: "/issues/1/comments", body: { body: "hi" } }),
      ).toMatchObject({ type: "json", data: { status: 201, body: { id: 5 } } });
      // GitHub's own failures are results for the caller, not route errors.
      expect(await request({ method: "GET", path: "/missing" })).toMatchObject({
        type: "json",
        data: { status: 404, body: { message: "Not Found" } },
      });
      for (const path of ["/../other", "/%2e%2e/other", "/issues?state=all", "issues"]) {
        expect(await request({ method: "GET", path })).toMatchObject({ type: "error" });
      }

      expect(calls[0]).toMatchObject({
        method: "POST",
        path: "/app/installations/58/access_tokens",
        body: { repository_ids: [10] },
      });
      expect(calls.slice(1).map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /repos/octo/repo/issues?state=open",
        "POST /repos/octo/repo/issues/1/comments",
        "GET /repos/octo/repo/missing",
      ]);
      expect(calls[2]?.body).toEqual({ body: "hi" });
    } finally {
      await test.cleanup();
    }
  });
});
