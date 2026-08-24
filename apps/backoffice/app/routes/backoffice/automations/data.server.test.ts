import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";

const { fetchWithContextMock, fetchMock } = vi.hoisted(() => ({
  fetchWithContextMock: vi.fn(),
  fetchMock: vi.fn(),
}));

import { deleteAutomationStoreEntry, lookupAutomationProject } from "./data.server";

const scope = { kind: "org" as const, orgId: "org-1" };
const execution = {
  scope,
  actors: {
    initiator: {
      scope: "internal" as const,
      type: "backoffice",
      id: "interactive",
      role: "initiator" as const,
    },
    principal: {
      scope: "internal" as const,
      type: "user",
      id: "user-1",
      role: "principal" as const,
    },
    delegation: [],
  },
};
const automationsObject = {
  fetch: fetchMock,
  fetchWithContext: fetchWithContextMock,
};
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
const propagationContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-01",
  tracestate: "vendor=value",
};
const request = new Request("https://backoffice.example/backoffice/automations/org/org-1/store", {
  method: "POST",
  headers: {
    ...propagationContext,
    baggage: "private=value",
  },
});

beforeEach(() => {
  fetchWithContextMock.mockReset();
  fetchMock.mockReset();
});

describe("lookupAutomationProject", () => {
  test("looks up one project for server-side scope validation", async () => {
    const project = { id: "project-1", slug: "project-one", name: "Project One" };
    fetchMock.mockResolvedValue(Response.json(project));

    await expect(lookupAutomationProject(context, scope.orgId, "project-1")).resolves.toEqual({
      status: "found",
      project,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [projectRequest] = fetchMock.mock.calls[0];
    assert(new URL(projectRequest.url).pathname === "/api/automations/projects/project-1");
  });

  test("distinguishes a missing project from synchronization failure", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: "Project not found", code: "PROJECT_NOT_FOUND" }, { status: 404 }),
    );

    await expect(lookupAutomationProject(context, scope.orgId, "missing")).resolves.toEqual({
      status: "not-found",
    });
  });
});

describe("deleteAutomationStoreEntry", () => {
  test("uses fetchWithContext for the store route", async () => {
    fetchWithContextMock.mockResolvedValue(Response.json({ ok: true, key: "ordinary/key" }));

    await expect(
      deleteAutomationStoreEntry(request, context, execution, "ordinary/key"),
    ).resolves.toEqual({ ok: true, error: null });

    expect(fetchWithContextMock).toHaveBeenCalledOnce();
    const [routeRequest, actionContext] = fetchWithContextMock.mock.calls[0];
    assert(new URL(routeRequest.url).pathname === "/api/automations/store/delete");
    await expect(routeRequest.json()).resolves.toEqual({ key: "ordinary/key" });
    expect(actionContext).toEqual({ execution, propagationContext });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("suppresses propagation when the request has no W3C carrier", async () => {
    fetchWithContextMock.mockResolvedValue(Response.json({ ok: true, key: "ordinary/key" }));
    const requestWithoutPropagation = new Request(request.url, { method: "POST" });

    await expect(
      deleteAutomationStoreEntry(requestWithoutPropagation, context, execution, "ordinary/key"),
    ).resolves.toEqual({ ok: true, error: null });

    expect(fetchWithContextMock).toHaveBeenCalledOnce();
    expect(fetchWithContextMock.mock.calls[0]?.[1]).toEqual({
      execution,
      propagationContext: null,
    });
  });

  test("preserves authorization failures returned by the Automations fragment", async () => {
    fetchWithContextMock.mockResolvedValue(
      Response.json(
        {
          message: "Forbidden",
          code: "principal-permission-denied",
        },
        { status: 403 },
      ),
    );

    const response = await deleteAutomationStoreEntry(
      request,
      context,
      execution,
      "ordinary/key",
    ).catch((error: unknown) => error);

    assert(response instanceof Response);
    assert(response.status === 403);
    await expect(response.json()).resolves.toEqual({
      message: "Forbidden",
      code: "principal-permission-denied",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("preserves authority resolution outages as HTTP 503", async () => {
    fetchWithContextMock.mockResolvedValue(
      Response.json(
        {
          message: "Backoffice authority resolution is unavailable.",
          code: "authority-unavailable",
        },
        { status: 503 },
      ),
    );

    const response = await deleteAutomationStoreEntry(
      request,
      context,
      execution,
      "ordinary/key",
    ).catch((error: unknown) => error);

    assert(response instanceof Response);
    assert(response.status === 503);
    await expect(response.json()).resolves.toEqual({
      message: "Backoffice authority resolution is unavailable.",
      code: "authority-unavailable",
    });
  });

  test("maps a missing entry without falling back to raw fetch", async () => {
    fetchWithContextMock.mockResolvedValue(
      Response.json(
        {
          message: "Store entry not found for missing/key.",
          code: "STORE_ENTRY_NOT_FOUND",
        },
        { status: 404 },
      ),
    );

    await expect(
      deleteAutomationStoreEntry(request, context, execution, "missing/key"),
    ).resolves.toEqual({
      ok: false,
      error: "Store entry not found for missing/key.",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
