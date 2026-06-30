import { afterEach, describe, expect, it, assert, vi } from "vitest";

import { buildHarness } from "./test-utils";

type FetchCall = {
  url: URL;
  init?: RequestInit;
};

const createFetchMock = () => {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);

    calls.push({ url, init });

    if (url.pathname === "/login/oauth/access_token") {
      return new Response(
        JSON.stringify({ access_token: "user-token", token_type: "bearer", scope: "" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.pathname === "/user") {
      return new Response(JSON.stringify({ id: 123, login: "octo" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/user/installations") {
      return new Response(
        JSON.stringify({
          total_count: 2,
          installations: [
            {
              id: 456,
              app_id: 42,
              app_slug: "test-app",
              account: { id: 789, login: "octo-org", type: "Organization" },
              repository_selection: "selected",
              permissions: { contents: "read" },
              events: ["pull_request"],
              html_url: "https://github.com/organizations/octo-org/settings/installations/456",
            },
            {
              id: 999,
              app_id: 99,
              app_slug: "other-app",
              account: { id: 111, login: "other", type: "Organization" },
              repository_selection: "all",
              permissions: {},
              events: [],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });

  return { fetchMock, calls };
};

describe("github-app OAuth routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies existing GitHub App installations through user authorization", async () => {
    const { fetchMock, calls } = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: "test-key",
      webhookSecret: "secret",
      apiBaseUrl: "https://api.github.test",
      webBaseUrl: "https://github.test",
    });

    try {
      const start = (await fragments.githubApp.callRoute("POST", "/oauth/start", {
        body: { subjectId: " backoffice-user-1 ", returnTo: "/after" },
      })) as {
        type: "json";
        data: { authorizationUrl: string; state: string; expiresAt: Date };
      };

      assert(start.type === "json");
      const authorizationUrl = new URL(start.data.authorizationUrl);
      assert(authorizationUrl.origin === "https://github.test");
      assert(authorizationUrl.searchParams.get("client_id") === "test-client-id");
      assert(
        authorizationUrl.searchParams.get("redirect_uri") === "https://example.com/github/callback",
      );
      expect(authorizationUrl.searchParams.get("state")).toBe(start.data.state);

      const complete = (await fragments.githubApp.callRoute("POST", "/oauth/complete", {
        body: {
          subjectId: "backoffice-user-1",
          state: start.data.state,
          code: "oauth-code",
        },
      })) as {
        type: "json";
        data: {
          githubUser: { id: string; login: string };
          installations: Array<{ id: string; accountLogin: string; appSlug: string }>;
          returnTo: string | null;
        };
      };

      assert(complete.type === "json");
      expect(complete.data.githubUser).toEqual({ id: "123", login: "octo" });
      assert(complete.data.returnTo === "/after");
      expect(complete.data.installations).toEqual([
        expect.objectContaining({ id: "456", accountLogin: "octo-org", appSlug: "test-app" }),
      ]);

      const tokenCall = calls.find((call) => call.url.pathname === "/login/oauth/access_token");
      expect(JSON.parse(String(tokenCall?.init?.body))).toMatchObject({
        client_secret: "test-client-secret",
        code: "oauth-code",
      });
    } finally {
      await test.cleanup();
    }
  });

  it("rejects whitespace-only subjects", async () => {
    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: "test-key",
      webhookSecret: "secret",
    });

    try {
      const start = (await fragments.githubApp.callRoute("POST", "/oauth/start", {
        body: { subjectId: "   " },
      })) as { type: "error" };

      assert(start.type === "error");
    } finally {
      await test.cleanup();
    }
  });

  it("rejects already-completed states before calling GitHub", async () => {
    const { fetchMock, calls } = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: "test-key",
      webhookSecret: "secret",
    });

    try {
      const start = (await fragments.githubApp.callRoute("POST", "/oauth/start", {
        body: { subjectId: "backoffice-user-1" },
      })) as { type: "json"; data: { state: string } };

      assert(start.type === "json");

      const firstComplete = (await fragments.githubApp.callRoute("POST", "/oauth/complete", {
        body: {
          subjectId: "backoffice-user-1",
          state: start.data.state,
          code: "oauth-code",
        },
      })) as { type: "json" };
      assert(firstComplete.type === "json");
      const apiCallCountAfterFirstComplete = calls.length;

      const secondComplete = (await fragments.githubApp.callRoute("POST", "/oauth/complete", {
        body: {
          subjectId: "backoffice-user-1",
          state: start.data.state,
          code: "oauth-code",
        },
      })) as { type: "error"; error: { code: string } };

      assert(secondComplete.type === "error");
      assert(secondComplete.error.code === "OAUTH_STATE_COMPLETED");
      expect(calls).toHaveLength(apiCallCountAfterFirstComplete);
    } finally {
      await test.cleanup();
    }
  });

  it("rejects completion by a different subject", async () => {
    const { fetchMock } = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { fragments, test } = await buildHarness({
      appId: "42",
      appSlug: "test-app",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      callbackUrl: "https://example.com/github/callback",
      privateKeyPem: "test-key",
      webhookSecret: "secret",
    });

    try {
      const start = (await fragments.githubApp.callRoute("POST", "/oauth/start", {
        body: { subjectId: "backoffice-user-1" },
      })) as { type: "json"; data: { state: string } };

      assert(start.type === "json");

      const complete = (await fragments.githubApp.callRoute("POST", "/oauth/complete", {
        body: {
          subjectId: "backoffice-user-2",
          state: start.data.state,
          code: "oauth-code",
        },
      })) as { type: "error"; error: { code: string } };

      assert(complete.type === "error");
      assert(complete.error.code === "SUBJECT_MISMATCH");
    } finally {
      await test.cleanup();
    }
  });
});
