import { beforeEach, describe, expect, test, vi, assert } from "vitest";

const { requireBackofficeContextMock, uploadFetchMock, getUploadDurableObjectMock } = vi.hoisted(
  () => ({
    requireBackofficeContextMock: vi.fn(),
    uploadFetchMock: vi.fn(),
    getUploadDurableObjectMock: vi.fn(),
  }),
);

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
  uploadFetchMock.mockReset();
  getUploadDurableObjectMock.mockReset();
  requireBackofficeContextMock.mockResolvedValue({});
  uploadFetchMock.mockResolvedValue(new Response("ok"));
  getUploadDurableObjectMock.mockReturnValue({ fetch: uploadFetchMock });
});

describe("Upload API proxy", () => {
  test("authorizes organisation access before forwarding the request", async () => {
    const request = new Request("https://example.test/api/upload/org-1/_internal/outbox");

    await loader({ request, context, params: { orgId: "org-1" } } as never);

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
    const request = new Request("https://example.test/api/upload/org-2/_internal/outbox");

    await expect(loader({ request, context, params: { orgId: "org-2" } } as never)).rejects.toBe(
      authorizationError,
    );

    expect(getUploadDurableObjectMock).not.toHaveBeenCalled();
    expect(uploadFetchMock).not.toHaveBeenCalled();
  });
});
