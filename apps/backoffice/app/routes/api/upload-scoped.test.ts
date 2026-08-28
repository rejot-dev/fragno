import { assert, beforeEach, describe, expect, test, vi } from "vitest";

const { requireBackofficeContextMock, scopedUploadMock, uploadFetchMock } = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
  scopedUploadMock: vi.fn(),
  uploadFetchMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { loader } from "./upload-scoped";

const uploadObject = { commands: {}, http: { fetch: uploadFetchMock } };
const uploadFamily = {};
const context = {
  get: () => ({
    runtime: { objects: { upload: uploadFamily } },
    kernel: { scoped: scopedUploadMock },
  }),
} as never;

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  scopedUploadMock.mockReset();
  uploadFetchMock.mockReset();
  requireBackofficeContextMock.mockResolvedValue({});
  scopedUploadMock.mockReturnValue(uploadObject);
  uploadFetchMock.mockResolvedValue(new Response("ok"));
});

describe("scoped Upload proxy", () => {
  test("uses the ID-backed runtime scope from the internal collection URL", async () => {
    const request = new Request(
      "https://backoffice.example/api/upload-scoped/org/org-123/_internal",
    );

    const response = await loader({
      request,
      context,
      params: { scopeKind: "org", scopeId: "org-123", "*": "_internal" },
    } as never);

    assert.equal(response.status, 200);
    expect(requireBackofficeContextMock).toHaveBeenCalledWith(request, context, {
      kind: "org",
      orgId: "org-123",
    });
    expect(scopedUploadMock).toHaveBeenCalledWith(
      "UPLOAD",
      { kind: "org", orgId: "org-123" },
      uploadFamily,
    );

    const forwardedRequest = uploadFetchMock.mock.calls[0][0] as Request;
    assert.equal(new URL(forwardedRequest.url).pathname, "/api/upload/_internal");
  });
});
