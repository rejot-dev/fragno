import { beforeEach, describe, expect, test, vi, assert } from "vitest";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";

const { fetchAuthorizedMock, fetchMock } = vi.hoisted(() => ({
  fetchAuthorizedMock: vi.fn(),
  fetchMock: vi.fn(),
}));

import { lookupAutomationProject } from "./data.server";

const scope = { kind: "org" as const, orgId: "org-1" };

const automationsObject = {
  commands: {},
  http: {
    fetch: fetchMock,
    fetchAuthorized: fetchAuthorizedMock,
  },
};
const runtime = {
  objects: {
    automations: {
      for: () => automationsObject,
    },
  },
  authorityResolver: unavailableBackofficeAuthorityResolver,
  kernelObserver: noopBackofficeKernelObserver,
};
const context = {
  get: () => ({ runtime, kernel: new BackofficeKernel(runtime) }),
} as never;
beforeEach(() => {
  fetchAuthorizedMock.mockReset();
  fetchMock.mockReset();
});

describe("lookupAutomationProject", () => {
  test("looks up one project for server-side scope validation", async () => {
    const project = { id: "project-1", slug: "project-one", name: "Project One" };
    fetchMock.mockResolvedValue(Response.json(project));

    await expect(
      lookupAutomationProject(context, scope.orgId, { projectId: "project-1" }),
    ).resolves.toEqual({
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

    await expect(
      lookupAutomationProject(context, scope.orgId, { projectId: "missing" }),
    ).resolves.toEqual({
      status: "not-found",
    });
  });
});
