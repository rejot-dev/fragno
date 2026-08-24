import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { authorizeBackofficeContextMock, apiFetchMock, apiForScopeMock, getOrganizationBySlugMock } =
  vi.hoisted(() => ({
    authorizeBackofficeContextMock: vi.fn(),
    apiFetchMock: vi.fn(),
    apiForScopeMock: vi.fn(),
    getOrganizationBySlugMock: vi.fn(),
  }));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  authorizeBackofficeContext: authorizeBackofficeContextMock,
}));

import { action } from "./api";
import { action as oauthStartAction } from "./api-oauth-start";

const apiObject = {
  fetch: apiFetchMock,
};
const context = {
  get: () => ({
    runtime: {
      config: { docsPublicBaseUrl: "https://public.example" },
      objects: {
        auth: { singleton: () => ({ getOrganizationBySlug: getOrganizationBySlugMock }) },
        api: { for: apiForScopeMock },
      },
    },
  }),
} as never;

beforeEach(() => {
  authorizeBackofficeContextMock.mockReset();
  apiFetchMock.mockReset();
  apiForScopeMock.mockReset();
  getOrganizationBySlugMock.mockReset();

  authorizeBackofficeContextMock.mockResolvedValue({ ok: true, headers: [] });
  apiForScopeMock.mockReturnValue(apiObject);
  apiFetchMock.mockResolvedValue(new Response("ok"));
});

describe("public API fragment route", () => {
  test("resolves an organization slug before selecting the ID-backed API object", async () => {
    getOrganizationBySlugMock.mockResolvedValue({ id: "org-123", slug: "acme" });
    const request = new Request(
      "https://backoffice.example/api/http/org%3Aacme/webhooks/endpoints/slack/events",
      { method: "POST" },
    );

    const response = await action({
      request,
      context,
      params: { scopeSegment: "org:acme", "*": "webhooks/endpoints/slack/events" },
    } as never);

    assert.equal(response.status, 200);
    expect(getOrganizationBySlugMock).toHaveBeenCalledWith("acme");
    expect(apiForScopeMock).toHaveBeenCalledWith({ kind: "org", orgId: "org-123" });
    expect(authorizeBackofficeContextMock).not.toHaveBeenCalled();

    const forwardedRequest = apiFetchMock.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    assert.equal(forwardedUrl.pathname, "/api/api/webhooks/endpoints/slack/events");
    assert.equal(forwardedUrl.searchParams.get("scope"), "org:org-123");
  });

  test("supplies the canonical slug-backed redirect URI when OAuth starts", async () => {
    getOrganizationBySlugMock.mockResolvedValue({ id: "org-123", slug: "acme" });
    const oauthOptionsBody = `{ "scopes": ["repo"] }`;
    const request = new Request(
      "https://backoffice.example/api/http/org%3Aacme/connections/github/auth/oauth/start?redirectUri=https%3A%2F%2Fattacker.example%2Fcallback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oauthOptionsBody,
      },
    );

    await oauthStartAction({
      request,
      context,
      params: { scopeSegment: "org:acme", connectionSlug: "github" },
    } as never);

    const forwardedRequest = apiFetchMock.mock.calls[0][0] as Request;
    assert.equal(
      new URL(forwardedRequest.url).searchParams.get("redirectUri"),
      "https://public.example/api/http/org%3Aacme/oauth/callback",
    );
    assert.equal(await forwardedRequest.text(), oauthOptionsBody);
  });

  test("does not interpret an organization ID as a public route identity", async () => {
    getOrganizationBySlugMock.mockResolvedValue(null);
    const request = new Request(
      "https://backoffice.example/api/http/org%3Aorg-123/webhooks/endpoints/slack/events",
      { method: "POST" },
    );

    const response = await action({
      request,
      context,
      params: { scopeSegment: "org:org-123", "*": "webhooks/endpoints/slack/events" },
    } as never);

    assert.equal(response.status, 404);
    expect(getOrganizationBySlugMock).toHaveBeenCalledWith("org-123");
    expect(apiForScopeMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
