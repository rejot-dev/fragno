import { beforeEach, describe, expect, test, vi, assert } from "vitest";

const {
  requireBackofficeContextMock,
  requireBackofficeMeMock,
  uploadFetchMock,
  getUploadDurableObjectMock,
} = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
  requireBackofficeMeMock: vi.fn(),
  uploadFetchMock: vi.fn(),
  getUploadDurableObjectMock: vi.fn(),
}));

vi.mock("@/fragno/auth/auth-server", () => ({
  requireBackofficeMe: requireBackofficeMeMock,
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

vi.mock("@/worker-runtime/durable-objects", () => ({
  getUploadDurableObject: getUploadDurableObjectMock,
}));

import { loader } from "./upload";

const context = {} as never;

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  requireBackofficeMeMock.mockReset();
  uploadFetchMock.mockReset();
  getUploadDurableObjectMock.mockReset();
  requireBackofficeContextMock.mockResolvedValue({});
  requireBackofficeMeMock.mockResolvedValue({
    organizations: [
      { organization: { id: "org-1", slug: "acme" } },
      { organization: { id: "org-2", slug: "other" } },
    ],
  });
  uploadFetchMock.mockResolvedValue(new Response("ok"));
  getUploadDurableObjectMock.mockReturnValue({ fetch: uploadFetchMock });
});

describe("Upload API proxy", () => {
  test("authorizes organization access before forwarding the request", async () => {
    const request = new Request("https://example.test/api/upload/acme/_internal/outbox");

    await loader({ request, context, params: { orgSlug: "acme" } } as never);

    expect(requireBackofficeContextMock).toHaveBeenCalledWith(request, context, {
      kind: "org",
      orgId: "org-1",
    });
    expect(getUploadDurableObjectMock).toHaveBeenCalledWith(context, "org-1");
    expect(uploadFetchMock).toHaveBeenCalledOnce();

    const forwardedRequest = uploadFetchMock.mock.calls[0][0] as Request;
    assert(new URL(forwardedRequest.url).pathname === "/api/upload/_internal/outbox");
    assert(new URL(forwardedRequest.url).searchParams.get("orgId") === "org-1");
  });

  test("does not reach the Durable Object when authorization fails", async () => {
    const authorizationError = new Response("Not Found", { status: 404 });
    requireBackofficeContextMock.mockRejectedValue(authorizationError);
    const request = new Request("https://example.test/api/upload/other/_internal/outbox");

    await expect(loader({ request, context, params: { orgSlug: "other" } } as never)).rejects.toBe(
      authorizationError,
    );

    expect(getUploadDurableObjectMock).not.toHaveBeenCalled();
    expect(uploadFetchMock).not.toHaveBeenCalled();
  });
});
