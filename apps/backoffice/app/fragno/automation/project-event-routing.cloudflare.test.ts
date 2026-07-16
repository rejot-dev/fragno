import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { env } from "cloudflare:workers";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createMasterFileSystem, createSystemFilesContext } from "@/files";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "./contracts";
import { createAutomationsRouteCaller } from "./route-callers";

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

describe("project automation event routing", () => {
  let runtime: InMemoryBackofficeRuntime | null = null;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = null;
  });

  test("forwards org events into active project automation routes", async () => {
    const orgId = "org-1";

    runtime = await createInMemoryBackofficeRuntime({
      env: { LOADER: env.LOADER },
    });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({
      object: orgAutomations,
      scope: { kind: "org", orgId },
    });
    await orgRoutes("POST", "/routes", {
      body: {
        id: "system-project-files-configure",
        name: "Configure project files",
        enabled: false,
        trigger: {
          kind: "event",
          source: "automations",
          eventType: "project.created",
          matcher: null,
        },
        priority: 15,
        action: {
          kind: "start_workflow",
          workflowName: "automation-codemode-script",
          remoteWorkflowName: "project-files-configure",
          workflowScriptPath: "/static/automations/project-files-configure.workflow.js",
          instanceIdTemplate: "project-files-configure-${event.id}",
        },
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
    const projectAutomations = runtime.objects.automations.forProject({ orgId, projectId });
    const createRouteResponse = await projectAutomations.fetch(
      new Request(
        `https://automations.do/api/automations/routes?scopeKind=project&orgId=${orgId}&projectId=${projectId}`,
        {
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
              workflowName: "automation-codemode-script",
              remoteWorkflowName: "project-store",
              workflowScriptPath: "/workspace/automations/project-store.workflow.js",
              instanceIdTemplate: "project-store-${event.id}",
            },
          }),
        },
      ),
    );
    assert(createRouteResponse.status === 201);
    const event: AutomationEvent = {
      id: "org-event-1",
      scope: { kind: "org", orgId },
      source: "test",
      eventType: "org.event",
      occurredAt: "2026-06-22T00:00:00.000Z",
      payload: {},
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
      subject: { orgId },
    };

    const events = createEventRuntime({
      objects: runtime.objects,
      kernel: new BackofficeKernel({ objects: runtime.objects }),
      execution: {
        actor: { type: "automation", id: "automation:org-event-1", organizationIds: [orgId] },
        scope: event.scope,
      },
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

    const workflowsResponse = await projectAutomations.fetch(
      new Request(
        `https://automations.do/api/automations-workflows/automation-codemode-script/instances?scopeKind=project&orgId=${orgId}&projectId=${projectId}`,
      ),
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

  test("emits project.created hooks and mounts configured project workspaces by slug", async () => {
    const orgId = "org-1";
    runtime = await createInMemoryBackofficeRuntime({ env: { LOADER: env.LOADER } });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({
      object: orgAutomations,
      scope: { kind: "org", orgId },
    });
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

    const hookQueue = await (
      await orgAutomations.getDurableHookRepository("automation")
    ).getHookQueue();
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

    const internal = createInternalRuntime({
      objects: runtime.objects,
      config: runtime.services.config,
      orgId,
      families: runtimeToolFamilies,
    });
    await expect(internal.configureProjectDatabaseFileSystem({ projectId })).resolves.toMatchObject(
      {
        projectId,
        provider: "database",
        configured: true,
        created: ["/workspace/README.md"],
      },
    );

    const fs = await createMasterFileSystem(
      createSystemFilesContext({
        objects: runtime.objects,
        execution: {
          actor: { type: "user", id: "user-1", userId: "user-1", organizationIds: [orgId] },
          scope: { kind: "org", orgId },
        },

        staticFileArtifacts: () => ({}),
      }),
    );
    await expect(fs.readdir("/projects")).resolves.toEqual(["mounted-plan"]);
    await fs.writeFile("/projects/mounted-plan/notes.txt", "project notes");
    await expect(fs.readFile("/projects/mounted-plan/notes.txt")).resolves.toBe("project notes");

    const projectFs = await createMasterFileSystem(
      createSystemFilesContext({
        objects: runtime.objects,
        execution: {
          actor: { type: "user", id: "user-1", userId: "user-1", organizationIds: [orgId] },
          scope: { kind: "project", orgId, projectId },
        },

        staticFileArtifacts: () => ({}),
      }),
    );
    await expect(projectFs.readFile("/workspace/notes.txt")).resolves.toBe("project notes");
  });

  test("does not instantiate project automations for archived projects", async () => {
    const orgId = "org-1";
    runtime = await createInMemoryBackofficeRuntime({ env: { LOADER: env.LOADER } });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({
      object: orgAutomations,
      scope: { kind: "org", orgId },
    });
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
      scope: { kind: "org", orgId },
      source: "test",
      eventType: "org.event",
      occurredAt: "2026-06-22T00:00:00.000Z",
      payload: {},
      actor: AUTOMATION_SYSTEM_ACTOR,
      actors: [AUTOMATION_SYSTEM_ACTOR],
      subject: { orgId },
    };
    const events = createEventRuntime({
      objects: runtime.objects,
      kernel: new BackofficeKernel({ objects: runtime.objects }),
      execution: {
        actor: {
          type: "automation",
          id: "automation:org-event-archived",
          organizationIds: [orgId],
        },
        scope: event.scope,
      },
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
