import { beforeEach, describe, expect, test, vi } from "vitest";

import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

const { requireBackofficeContextMock } = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { loader } from "./identity-bindings";

const scope = { kind: "org" as const, orgId: "org-1" };
const execution = { scope };
const request = new Request(
  "https://backoffice.example/backoffice/automations/org/org-1/store/identity-bindings",
);
const assertAuthorized = vi.fn();
const context = {
  get: () => ({ kernel: { assertAuthorized } }),
} as never;

beforeEach(() => {
  requireBackofficeContextMock.mockReset();
  assertAuthorized.mockReset();
  requireBackofficeContextMock.mockResolvedValue(execution);
});

describe("automation identity bindings loader", () => {
  test("requires identity read permission for the selected scope", async () => {
    await expect(
      loader({
        request,
        context,
        params: { scopeKind: "org", scopeId: "org-1" },
      } as never),
    ).resolves.toBeNull();

    expect(requireBackofficeContextMock).toHaveBeenCalledWith(request, context, scope);
    expect(assertAuthorized).toHaveBeenCalledWith({
      execution,
      operation: BACKOFFICE_PERMISSION.identity.read,
      resource: { kind: "external-identity-bindings" },
    });
  });

  test("maps permission denial to an HTTP 403 response", async () => {
    assertAuthorized.mockRejectedValue(new BackofficeForbiddenError("Forbidden"));

    const response = await loader({
      request,
      context,
      params: { scopeKind: "org", scopeId: "org-1" },
    } as never).catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    expect(response).toMatchObject({ status: 403 });
    await expect((response as Response).text()).resolves.toBe("Forbidden");
  });
});
