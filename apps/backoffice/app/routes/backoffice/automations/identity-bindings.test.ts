import { beforeEach, describe, expect, test, vi } from "vitest";

import { BackofficeForbiddenError } from "@/backoffice-runtime/kernel";
import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";

const { requireAutomationRouteExecutionMock } = vi.hoisted(() => ({
  requireAutomationRouteExecutionMock: vi.fn(),
}));

vi.mock("./scope.server", () => ({
  requireAutomationRouteExecution: requireAutomationRouteExecutionMock,
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
  requireAutomationRouteExecutionMock.mockReset();
  assertAuthorized.mockReset();
  requireAutomationRouteExecutionMock.mockResolvedValue(execution);
});

describe("automation identity bindings loader", () => {
  test("requires identity read permission for the selected scope", async () => {
    await expect(
      loader({
        request,
        context,
        params: { scopeKind: "org", scopeId: "ada-labs" },
      } as never),
    ).resolves.toBeNull();

    expect(requireAutomationRouteExecutionMock).toHaveBeenCalledWith(request, context, {
      scopeKind: "org",
      scopeId: "ada-labs",
    });
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
      params: { scopeKind: "org", scopeId: "ada-labs" },
    } as never).catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    expect(response).toMatchObject({ status: 403 });
    await expect((response as Response).text()).resolves.toBe("Forbidden");
  });
});
