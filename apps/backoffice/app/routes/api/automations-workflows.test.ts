import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { authorizeAccessTokenForOrganizationMock, getAutomationsDurableObjectMock, fetchMock } =
  vi.hoisted(() => ({
    authorizeAccessTokenForOrganizationMock: vi.fn(),
    getAutomationsDurableObjectMock: vi.fn(),
    fetchMock: vi.fn(),
  }));

vi.mock("@/fragno/auth/access-token.server", () => ({
  authorizeAccessTokenForOrganization: authorizeAccessTokenForOrganizationMock,
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
  getAutomationsDurableObject: getAutomationsDurableObjectMock,
}));

import { action, loader } from "./automations-workflows";

const context = {} as never;

beforeEach(() => {
  authorizeAccessTokenForOrganizationMock.mockReset();
  getAutomationsDurableObjectMock.mockReset();
  fetchMock.mockReset();
  authorizeAccessTokenForOrganizationMock.mockResolvedValue({
    ok: true,
    principal: {},
    headers: [],
  });
  getAutomationsDurableObjectMock.mockReturnValue({ fetch: fetchMock });
  fetchMock.mockResolvedValue(new Response("ok"));
});

describe("organization Automations workflows proxy", () => {
  test("forwards authenticated workflow routes to the workflows fragment", async () => {
    const request = new Request(
      "https://backoffice.example/api/automations-workflows/org-1/workflow/instances?cursor=next",
    );

    const response = await loader({
      request,
      context,
      params: { orgId: "org-1", "*": "workflow/instances" },
    });

    assert.equal(response.status, 200);
    expect(authorizeAccessTokenForOrganizationMock).toHaveBeenCalledWith(request, context, "org-1");
    expect(getAutomationsDurableObjectMock).toHaveBeenCalledWith(context, "org-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const forwardedUrl = new URL((fetchMock.mock.calls[0][0] as Request).url);
    assert.equal(forwardedUrl.pathname, "/api/automations-workflows/workflow/instances");
    assert.equal(forwardedUrl.searchParams.get("cursor"), "next");
    assert.equal(forwardedUrl.searchParams.get("orgId"), "org-1");
  });

  test("forwards workflow actions without changing the request method or body", async () => {
    const request = new Request(
      "https://backoffice.example/api/automations-workflows/org-1/workflow/instances",
      {
        method: "POST",
        body: JSON.stringify({ workflowName: "example" }),
      },
    );

    const response = await action({
      request,
      context,
      params: { orgId: "org-1", "*": "workflow/instances" },
    });

    assert.equal(response.status, 200);
    const forwardedRequest = fetchMock.mock.calls[0][0] as Request;
    assert.equal(forwardedRequest.method, "POST");
    assert.deepEqual(await forwardedRequest.json(), { workflowName: "example" });
  });

  test("returns the authorization response without contacting the Durable Object", async () => {
    authorizeAccessTokenForOrganizationMock.mockResolvedValue({
      ok: false,
      response: new Response("Forbidden", { status: 403 }),
    });
    const request = new Request(
      "https://backoffice.example/api/automations-workflows/org-1/workflow/instances",
    );

    const response = await loader({
      request,
      context,
      params: { orgId: "org-1", "*": "workflow/instances" },
    });

    assert.equal(response.status, 403);
    expect(getAutomationsDurableObjectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects requests without an organization id", async () => {
    const request = new Request(
      "https://backoffice.example/api/automations-workflows/workflow/instances",
    );

    const response = await loader({ request, context, params: {} });

    assert.equal(response.status, 400);
    expect(authorizeAccessTokenForOrganizationMock).not.toHaveBeenCalled();
    expect(getAutomationsDurableObjectMock).not.toHaveBeenCalled();
  });
});
