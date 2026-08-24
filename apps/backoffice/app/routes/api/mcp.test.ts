import { assert, beforeEach, describe, test, vi } from "vitest";

const { authorizeBackofficeContextMock, getOrganizationBySlugMock, mcpFetchMock, mcpForScopeMock } =
  vi.hoisted(() => ({
    authorizeBackofficeContextMock: vi.fn(),
    getOrganizationBySlugMock: vi.fn(),
    mcpFetchMock: vi.fn(),
    mcpForScopeMock: vi.fn(),
  }));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  authorizeBackofficeContext: authorizeBackofficeContextMock,
}));

import { loader as mcpLoader } from "./mcp";
import { action as oauthStartAction } from "./mcp-oauth-start";

const mcpObject = { fetch: mcpFetchMock };
const context = {
  get: () => ({
    runtime: {
      config: { docsPublicBaseUrl: "https://public.example" },
      objects: {
        auth: { singleton: () => ({ getOrganizationBySlug: getOrganizationBySlugMock }) },
        mcp: { for: mcpForScopeMock },
      },
    },
  }),
};

beforeEach(() => {
  authorizeBackofficeContextMock.mockReset();
  getOrganizationBySlugMock.mockReset();
  mcpFetchMock.mockReset();
  mcpForScopeMock.mockReset();

  authorizeBackofficeContextMock.mockResolvedValue({ ok: true, headers: [] });
  getOrganizationBySlugMock.mockResolvedValue({ id: "org-123", slug: "acme" });
  mcpForScopeMock.mockReturnValue(mcpObject);
  mcpFetchMock.mockResolvedValue(Response.json({ authorizationUrl: "https://provider.example" }));
});

describe("public MCP OAuth routes", () => {
  test("completes an OAuth callback without Backoffice authentication", async () => {
    mcpFetchMock.mockResolvedValue(Response.json({ authenticated: true, mode: "oauth" }));
    const request = new Request(
      "https://backoffice.example/api/mcp/org%3Aacme/oauth/callback?code=oauth-code&state=github%3Astate-id",
    );

    const response = await mcpLoader({
      request,
      context,
      params: { scopeSegment: "org:acme", "*": "oauth/callback" },
    } as never);

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "https://backoffice.example/backoffice/automations/org/acme/mcp?oauth=success&server=github",
    );
    assert.deepEqual(mcpForScopeMock.mock.calls[0], [{ kind: "org", orgId: "org-123" }]);
    assert.equal(authorizeBackofficeContextMock.mock.calls.length, 0);

    const forwardedRequest = mcpFetchMock.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    assert.equal(forwardedUrl.pathname, "/api/mcp/oauth/callback");
    assert.equal(forwardedUrl.searchParams.get("scope"), "org:org-123");
    assert.equal(forwardedUrl.searchParams.get("code"), "oauth-code");
    assert.equal(forwardedUrl.searchParams.get("state"), "github:state-id");
  });

  test("supplies the canonical slug-backed redirect URI without interpreting the body", async () => {
    const oauthOptionsBody = `{ "scope": "tools" }`;
    const request = new Request(
      "https://backoffice.example/api/mcp/org%3Aacme/servers/github/auth/start?redirectUri=https%3A%2F%2Fattacker.example%2Fcallback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oauthOptionsBody,
      },
    );

    await oauthStartAction({
      request,
      context,
      params: { scopeSegment: "org:acme", serverSlug: "github" },
    } as never);

    assert.deepEqual(mcpForScopeMock.mock.calls[0], [{ kind: "org", orgId: "org-123" }]);
    const forwardedRequest = mcpFetchMock.mock.calls[0][0] as Request;
    assert.equal(
      new URL(forwardedRequest.url).searchParams.get("redirectUri"),
      "https://public.example/api/mcp/org%3Aacme/oauth/callback",
    );
    assert.equal(await forwardedRequest.text(), oauthOptionsBody);
  });
});
