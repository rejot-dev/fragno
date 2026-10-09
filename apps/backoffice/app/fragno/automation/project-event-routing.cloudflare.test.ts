import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { env } from "cloudflare:workers";

import { unavailableBackofficeAuthorityResolver } from "@/backoffice-runtime/authority-resolver";
import {
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
} from "@/backoffice-runtime/context";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel, noopBackofficeKernelObserver } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createStateShellFileSystem } from "@/fragno/runtime-tools/state-shell-file-system";

import { InMemoryAutomationsObject } from "../../../workers/automations.do";
import { InMemoryUploadObject } from "../../../workers/upload.do";
import { AUTOMATION_SYSTEM_INITIATOR } from "./actors";
import { createAutomationRuntimeExecution } from "./authority";
import type { AutomationEvent } from "./contracts";
import { createAutomationsRouteCaller } from "./route-callers";

const localObjects = {
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
} satisfies LocalBackofficeObjects;

const { DurableObject, RpcTarget, WorkerEntrypoint } = vi.hoisted(() => {
  class MockDurableObject {
    constructor(_state: unknown, _env: unknown) {}
  }

  class MockRpcTarget {}
  class MockWorkerEntrypoint {}

  return {
    DurableObject: MockDurableObject,
    RpcTarget: MockRpcTarget,
    WorkerEntrypoint: MockWorkerEntrypoint,
  };
});

vi.mock("cloudflare:workers", async () => ({
  DurableObject,
  RpcTarget,
  WorkerEntrypoint,
  env: await vi.importActual("cloudflare:workers").then((mod) => mod.env),
}));

const idValue = (id: unknown): string => {
  if (typeof id === "object" && id && "externalId" in id) {
    return String((id as { externalId: unknown }).externalId);
  }
  return String(id);
};

function createScopedTestFileSystem(
  runtime: InMemoryBackofficeRuntime,
  execution: BackofficeExecutionContext,
) {
  return createStateShellFileSystem(
    createRuntimeStateBackend({
      runtime: runtime.services,
      kernel: new BackofficeKernel(runtime.services),
      execution,
    }),
  );
}

describe("project automation event routing", () => {
  let runtime: InMemoryBackofficeRuntime | null = null;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = null;
  });

  test("forwards org events into active project automation routes", async () => {
    const orgId = "org-1";

    runtime = await createInMemoryBackofficeRuntime({ objects: localObjects });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({
      object: orgAutomations,
      context: {
        execution: createBackofficeSystemExecution({ kind: "org", orgId }),
        propagationContext: null,
      },
    });
    const createProjectResponse = await orgRoutes("POST", "/projects", {
      body: {
        name: "Launch Plan",
        slug: "launch-plan",
        createdByUserId: "user-1",
      },
    });
    assert(createProjectResponse.type === "json");
    if (createProjectResponse.type !== "json") {
      throw new Error("Project creation failed.");
    }

    const projectId = idValue(createProjectResponse.data.id);
    const projectFileSystem = createScopedTestFileSystem(
      runtime,
      createBackofficeUserExecution({
        scope: { kind: "project", orgId, projectId },
        userId: "user-1",
      }),
    );
    await projectFileSystem.mkdir("/workspace/automations", { recursive: true });
    await projectFileSystem.writeFile(
      "/workspace/automations/project-store.workflow.js",
      `defineWorkflow({ name: "project-store" }, async (event) => event.payload);`,
    );

    const projectAutomations = runtime.objects.automations.forProject({ orgId, projectId });
    const projectRoutesUrl =
      `https://automations.do/api/automations/routes?scopeKind=project` +
      `&orgId=${orgId}&projectId=${projectId}`;
    const initialRoutesResponse = await projectAutomations.http.fetch(
      new Request(projectRoutesUrl),
    );
    assert(initialRoutesResponse.status === 200);
    await expect(initialRoutesResponse.json()).resolves.toEqual([]);

    const createRouteResponse = await projectAutomations.http.fetchAuthorized(
      new Request(projectRoutesUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "project-store-route",
          name: "Project store route",
          enabled: true,
          trigger: {
            kind: "event",
            source: "test",
            eventType: "project.event",
            matcher: null,
          },
          priority: 50,
          action: {
            kind: "start_workflow",
            authority: { kind: "organization-automation", grants: [] },
            workflowScriptPath: "/workspace/automations/project-store.workflow.js",
            instanceIdTemplate: "project-store-${event.id}",
          },
        }),
      }),
      {
        execution: createBackofficeSystemExecution({ kind: "project", orgId, projectId }),
        propagationContext: null,
      },
    );
    assert(createRouteResponse.status === 201);
    const event: AutomationEvent = {
      id: "org-event-1",
      scopeRestriction: null,
      scope: { kind: "org", orgId },
      source: "test",
      eventType: "org.event",
      occurredAt: "2026-06-22T00:00:00.000Z",
      payload: {},
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
      subject: { orgId },
    };

    const events = createEventRuntime({
      objects: runtime.objects,
      kernel: new BackofficeKernel({
        authorityResolver: unavailableBackofficeAuthorityResolver,
        kernelObserver: noopBackofficeKernelObserver,
      }),
      execution: createAutomationRuntimeExecution({
        event,
        authority: {
          mode: { kind: "organization-automation", grants: [] },
          automationId: "automation-route:project-event",
        },
      }),
      parentEvent: event,
    });

    await expect(
      events.emitEvent({
        eventType: "project.event",
        targetScope: { kind: "project", orgId, projectId },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      scope: { kind: "project", orgId, projectId },
    });

    await runtime.drain();

    const workflowsResponse = await projectAutomations.http.fetchAuthorized(
      new Request("https://automations.do/api/workflows/codemode-script/instances"),
      {
        execution: createBackofficeSystemExecution({ kind: "project", orgId, projectId }),
        propagationContext: null,
      },
    );
    assert(workflowsResponse.status === 200);
    const workflows = (await workflowsResponse.json()) as {
      instances: Array<{ id: string }>;
    };
    expect(workflows.instances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^project-store-[0-9a-f-]{36}$/u),
        }),
      ]),
    );
  });

  test("emits project.created hooks and isolates project-scoped workspaces", async () => {
    const orgId = "org-1";
    runtime = await createInMemoryBackofficeRuntime({
      objects: localObjects,
      env: { codemode: env },
    });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({ object: orgAutomations });
    const createProjectResponse = await orgRoutes("POST", "/projects", {
      body: {
        name: "Mounted Plan",
        slug: "mounted-plan",
        createdByUserId: "user-1",
      },
    });
    assert(createProjectResponse.type === "json");
    if (createProjectResponse.type !== "json") {
      throw new Error("Project creation failed.");
    }
    const projectId = idValue(createProjectResponse.data.id);

    const hookQueue = await orgAutomations.commands.getDurableHookQueue("automation");
    expect(hookQueue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookName: "internalIngestEvent",
          payload: expect.objectContaining({
            event: expect.objectContaining({
              source: "automations",
              eventType: "project.created",
              scope: { kind: "org", orgId },
              subject: { orgId, projectId },
            }),
          }),
        }),
      ]),
    );

    const fs = createScopedTestFileSystem(
      runtime,
      createBackofficeUserExecution({
        scope: { kind: "org", orgId },
        userId: "user-1",
      }),
    );
    await expect(fs.readdir("/")).resolves.toEqual(["static", "workspace"]);
    await fs.writeFile("/workspace/notes.txt", "org notes");

    const projectFs = createScopedTestFileSystem(
      runtime,
      createBackofficeUserExecution({
        scope: { kind: "project", orgId, projectId },
        userId: "user-1",
      }),
    );
    await expect(projectFs.readdir("/")).resolves.toEqual(["static", "workspace"]);
    await expect(projectFs.readdir("/workspace")).resolves.toEqual([]);
    await projectFs.writeFile("/workspace/notes.txt", "project notes");
    await expect(projectFs.readFile("/workspace/notes.txt")).resolves.toBe("project notes");
    await expect(fs.readFile("/workspace/notes.txt")).resolves.toBe("org notes");
  });

  test("does not instantiate project automations for archived projects", async () => {
    const orgId = "org-1";
    runtime = await createInMemoryBackofficeRuntime({
      objects: localObjects,
      env: { codemode: env },
    });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({ object: orgAutomations });
    const createProjectResponse = await orgRoutes("POST", "/projects", {
      body: {
        name: "Archived Plan",
        slug: "archived-plan",
        createdByUserId: "user-1",
      },
    });
    assert(createProjectResponse.type === "json");
    if (createProjectResponse.type !== "json") {
      throw new Error("Project creation failed.");
    }
    const projectId = idValue(createProjectResponse.data.id);
    await orgRoutes("DELETE", "/projects/:projectId", { pathParams: { projectId } });

    const event: AutomationEvent = {
      id: "org-event-archived",
      scopeRestriction: null,
      scope: { kind: "org", orgId },
      source: "test",
      eventType: "org.event",
      occurredAt: "2026-06-22T00:00:00.000Z",
      payload: {},
      actors: {
        initiator: AUTOMATION_SYSTEM_INITIATOR,
        principal: null,
        delegation: [],
      },
      subject: { orgId },
    };
    const events = createEventRuntime({
      objects: runtime.objects,
      kernel: new BackofficeKernel({
        authorityResolver: unavailableBackofficeAuthorityResolver,
        kernelObserver: noopBackofficeKernelObserver,
      }),
      execution: createAutomationRuntimeExecution({
        event,
        authority: {
          mode: { kind: "organization-automation", grants: [] },
          automationId: "automation-route:project-event",
        },
      }),
      parentEvent: event,
    });

    await expect(
      events.emitEvent({
        eventType: "project.event",
        targetScope: { kind: "project", orgId, projectId },
      }),
    ).rejects.toThrow(`Project '${projectId}' is not available.`);

    assert(
      !runtime.hasObjectInstance({
        binding: "AUTOMATIONS",
        scope: { kind: "project", orgId, projectId },
      }),
    );
  });
});
