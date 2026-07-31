import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";

const { requireBackofficeContextMock, automationsFetchMock } = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
  automationsFetchMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { action, loader } from "./automations-scoped";

const automationsObject = { fetch: automationsFetchMock };
const runtime = {
  objects: {
    automations: {
      singleton: () => automationsObject,
      forOrg: () => automationsObject,
      forUser: () => automationsObject,
      forProject: () => automationsObject,
    },
  },
  authorityResolver: unavailableBackofficeAuthorityResolver,
  kernelObserver: noopBackofficeKernelObserver,
};
const context = {
  get: () => ({ runtime, kernel: new BackofficeKernel(runtime) }),
} as never;

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  automationsFetchMock.mockReset();
  requireBackofficeContextMock.mockResolvedValue({});
  automationsFetchMock.mockResolvedValue(new Response("ok"));
});

describe("scoped Automations outbox proxy", () => {
  test("authorizes and forwards internal outbox requests", async () => {
    const request = new Request(
      "https://backoffice.example/api/automations-scoped/org/org-1/_internal/outbox",
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
    expect(automationsFetchMock).toHaveBeenCalledOnce();

    const forwardedRequest = automationsFetchMock.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    assert.equal(forwardedUrl.pathname, "/api/automations/_internal/outbox");
    assert.equal(forwardedUrl.search, "");
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
