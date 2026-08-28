import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { BACKOFFICE_INTERNAL_CONTEXT_HEADER } from "@/backoffice-runtime/internal-object-request";

const {
  requireBackofficeContextMock,
  automationsFetchMock,
  idFromNameMock,
  getAutomationsStubMock,
} = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
  automationsFetchMock: vi.fn(),
  idFromNameMock: vi.fn(),
  getAutomationsStubMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { action, loader } from "./automations-scoped";

const automationsObject = {
  fetch: automationsFetchMock,
};
const env = {
  AUTOMATIONS: {
    idFromName: idFromNameMock,
    get: getAutomationsStubMock,
  },
};
const context = {
  get: () => ({ env }),
} as never;

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  automationsFetchMock.mockReset();
  idFromNameMock.mockReset();
  getAutomationsStubMock.mockReset();

  requireBackofficeContextMock.mockResolvedValue({});
  automationsFetchMock.mockResolvedValue(new Response("ok"));
  idFromNameMock.mockImplementation((name: string) => `id:${name}`);
  getAutomationsStubMock.mockReturnValue(automationsObject);
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
    expect(idFromNameMock).toHaveBeenCalledWith("v1:org:org-1");
    expect(getAutomationsStubMock).toHaveBeenCalledWith("id:v1:org:org-1");
    expect(automationsFetchMock).toHaveBeenCalledOnce();

    const forwardedRequest = automationsFetchMock.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    assert.equal(forwardedUrl.pathname, "/api/automations/_internal/outbox");
    assert.equal(forwardedUrl.search, "");
    assert(!forwardedRequest.headers.has(BACKOFFICE_INTERNAL_CONTEXT_HEADER));
  });

  test("cancels the Durable Object response when the browser request disconnects", async () => {
    const requestController = new AbortController();
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    automationsFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          cancel() {
            resolveCancellation();
          },
        }),
      ),
    );
    const request = new Request(
      "https://backoffice.example/api/automations-scoped/org/org-1/_internal/outbox/stream",
      { signal: requestController.signal },
    );

    const response = await loader({
      request,
      context,
      params: { scopeKind: "org", scopeId: "org-1", "*": "_internal/outbox/stream" },
    });
    requestController.abort();

    await cancellation;
    const reader = response.body?.getReader();
    assert(reader);
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();
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
