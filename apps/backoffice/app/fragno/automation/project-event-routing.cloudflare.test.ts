import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { env } from "cloudflare:workers";

import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import { createMasterFileSystem, createSystemFilesContext } from "@/files";
import { createTestMasterFileSystem } from "@/fragno/automation/engine/test-master-file-system.test-utils";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { createRouteBackedAutomationStoreRuntime } from "./bindings-route-runtime";
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

  test("forwards org events into active project automations and uses project-local store", async () => {
    const orgId = "org-1";
    const projectFileSystems = new Map<string, ReturnType<typeof createTestMasterFileSystem>>();
    const orgFileSystem = createTestMasterFileSystem({});

    runtime = await createInMemoryBackofficeRuntime({
      env: { LOADER: env.LOADER },
      getAutomationFileSystem: async ({ execution }) => {
        if (execution.scope.kind === "project") {
          let fs = projectFileSystems.get(execution.scope.projectId);
          if (!fs) {
            fs = createTestMasterFileSystem({
              "/workspace/automations/project-store.sh": `event_id="$(jq -r '.id' /context/event.json)"
store.set --key project/last-event --value "$event_id" --actor '{"scope":"internal","type":"system","id":"project-test"}'
`,
            });
            projectFileSystems.set(execution.scope.projectId, fs);
          }
          return fs;
        }

        return orgFileSystem;
      },
    });

    const orgAutomations = runtime.objects.automations.forOrg(orgId);
    const orgRoutes = createAutomationsRouteCaller({ object: orgAutomations });
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
      event,
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

    const projectStore = createRouteBackedAutomationStoreRuntime({
      object: runtime.objects.automations.forProject({ orgId, projectId }),
    });
    await expect(projectStore.get({ key: "project/last-event" })).resolves.toMatchObject({
      key: "project/last-event",
      value: expect.stringContaining("project.event"),
    });
  });

  test("emits project.created hooks and mounts configured project workspaces by slug", async () => {
    const orgId = "org-1";
    runtime = await createInMemoryBackofficeRuntime({ env: { LOADER: env.LOADER } });

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

    const hookQueue = await (
      await orgAutomations.getDurableHookRepository("automation")
    ).getHookQueue();
    expect(hookQueue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hookName: "internalIngestEvent",
          payload: expect.objectContaining({
            source: "automations",
            eventType: "project.created",
            scope: { kind: "org", orgId },
            subject: { orgId, projectId },
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
      }),
    );
    await expect(projectFs.readFile("/workspace/notes.txt")).resolves.toBe("project notes");
  });

  test("does not instantiate project automations for archived projects", async () => {
    const orgId = "org-1";
    runtime = await createInMemoryBackofficeRuntime({ env: { LOADER: env.LOADER } });

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
      event,
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
