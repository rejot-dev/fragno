import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { BACKOFFICE_INTERNAL_CONTEXT_HEADER } from "@/backoffice-runtime/internal-object-request";

const { requireBackofficeContextMock, automationsFetchMock, automationsForScopeMock } = vi.hoisted(
  () => ({
    requireBackofficeContextMock: vi.fn(),
    automationsFetchMock: vi.fn(),
    automationsForScopeMock: vi.fn(),
  }),
);

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { action, loader } from "./automations-scoped";

const automationsObject = {
  http: {
    fetch: automationsFetchMock,
  },
};
const runtime = {
  objects: {
    automations: {
      for: automationsForScopeMock,
    },
  },
};
const context = {
  get: () => ({ runtime }),
} as never;

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  automationsFetchMock.mockReset();
  automationsForScopeMock.mockReset();

  requireBackofficeContextMock.mockResolvedValue({});
  automationsFetchMock.mockResolvedValue(new Response("ok"));
  automationsForScopeMock.mockReturnValue(automationsObject);
});

describe("scoped Automations outbox proxy", () => {
  test("authorizes and forwards internal outbox requests through the Durable Object fetch boundary", async () => {
    const request = new Request(
      "https://backoffice.example/api/automations-scoped/org/org-1/_internal/outbox",
      { headers: { [BACKOFFICE_INTERNAL_CONTEXT_HEADER]: "caller-controlled" } },
    );

    const response = await loader({
      request,
      context,
      params: { scopeKind: "org", scopeId: "org-1", "*": "_internal/outbox" },
    });

    assert.equal(response.status, 200);
    expect(requireBackofficeContextMock).toHaveBeenCalledWith(request, context, {
      kind: "org",
      orgId: "org-1",
    });
    expect(automationsForScopeMock).toHaveBeenCalledWith({
      kind: "org",
      orgId: "org-1",
    });
    expect(automationsFetchMock).toHaveBeenCalledOnce();

    const forwardedRequest = automationsFetchMock.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    assert.equal(forwardedUrl.pathname, "/api/automations/_internal/outbox");
    assert.equal(forwardedUrl.search, "");
    assert(!forwardedRequest.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER));
  });

  test("passes the Durable Object's outbox stream through untouched", async () => {
    const upstream = new Response(new ReadableStream());
    automationsFetchMock.mockResolvedValueOnce(upstream);

    const response = await loader({
      request: new Request(
        "https://backoffice.example/api/automations-scoped/org/org-1/_internal/outbox/stream",
      ),
      context,
      params: { scopeKind: "org", scopeId: "org-1", "*": "_internal/outbox/stream" },
    });

    assert.strictEqual(response, upstream);
    expect(automationsFetchMock).toHaveBeenCalledWith(expect.any(Request), { passThrough: true });
  });

  test("does not expose fragment mutation routes through the catch-all", async () => {
    const request = new Request(
      "https://backoffice.example/api/automations-scoped/org/org-1/store/delete",
      { method: "POST", body: JSON.stringify({ key: "secret" }) },
    );

    const response = await action({
      request,
      context,
      params: { scopeKind: "org", scopeId: "org-1", "*": "store/delete" },
    });

    assert.equal(response.status, 404);
    expect(requireBackofficeContextMock).toHaveBeenCalledOnce();
    expect(automationsFetchMock).not.toHaveBeenCalled();
  });
});
