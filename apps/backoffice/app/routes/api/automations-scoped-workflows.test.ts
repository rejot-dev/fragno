import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";

const { requireBackofficeContextMock } = vi.hoisted(() => ({
  requireBackofficeContextMock: vi.fn(),
}));

vi.mock("@/fragno/auth/backoffice-principal.server", () => ({
  requireBackofficeContext: requireBackofficeContextMock,
}));

import { action } from "./automations-scoped-workflows";

const projectFetch = vi.fn();
const forProject = vi.fn(() => ({ fetch: projectFetch }));
const runtime = {
  objects: {
    automations: {
      singleton: vi.fn(),
      forOrg: vi.fn(),
      forUser: vi.fn(),
      forProject,
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
  projectFetch.mockReset();
  forProject.mockClear();
  requireBackofficeContextMock.mockResolvedValue({});
  projectFetch.mockResolvedValue(Response.json({ accepted: true }));
});

describe("scoped Automations workflows API proxy", () => {
  test("forwards project workflow events to the project-scoped object", async () => {
    const request = new Request(
      "https://example.test/api/automations-scoped/project/org-1%3Aproject-1/workflows/reson8-setup/instances/instance-1/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "event-1", type: "submitted", payload: {} }),
      },
    );

    await action({
      request,
      context,
      params: {
        scopeKind: "project",
        scopeId: "org-1:project-1",
        "*": "reson8-setup/instances/instance-1/events",
      },
    });

    const scope = { kind: "project", orgId: "org-1", projectId: "project-1" };
    expect(requireBackofficeContextMock).toHaveBeenCalledWith(request, context, scope);
    expect(forProject).toHaveBeenCalledWith({ orgId: "org-1", projectId: "project-1" });
    expect(projectFetch).toHaveBeenCalledOnce();

    const forwardedRequest = projectFetch.mock.calls[0]?.[0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    assert(
      forwardedUrl.pathname ===
        "/api/automations-workflows/reson8-setup/instances/instance-1/events",
    );
    expect(Object.fromEntries(forwardedUrl.searchParams)).toEqual({
      scopeKind: "project",
      orgId: "org-1",
      projectId: "project-1",
    });
    expect(await forwardedRequest.json()).toEqual({
      id: "event-1",
      type: "submitted",
      payload: {},
    });
  });
});
