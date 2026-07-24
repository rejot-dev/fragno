import { assert, describe, expect, it } from "vitest";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import {
  SYSTEM_AUTOMATION_CONTENT,
  SYSTEM_AUTOMATION_SCRIPT_PATHS,
} from "@/files/content/system-automations";

import { internalToolFamily } from "./families/internal";
import {
  createRuntimeToolWorkflowCatalog,
  resolveWorkflowRuntimeToolCalls,
} from "./workflow-catalog";

const internalCatalog = createRuntimeToolWorkflowCatalog([internalToolFamily]);

describe("runtime-tool workflow catalog", () => {
  it("projects canonical runtime-tool descriptions into serializable metadata", () => {
    expect(
      internalCatalog.find((tool) => tool.qualifiedName === "internal.projectFilesConfigure"),
    ).toEqual({
      id: "internal.project.files.configure",
      namespace: "internal",
      name: "projectFilesConfigure",
      qualifiedName: "internal.projectFilesConfigure",
      summary: "Configure a project-scoped database-backed workspace filesystem.",
      description:
        "Selects the database upload provider and initializes the project workspace README when it is missing.",
    });
  });

  it("links direct and supported scoped provider calls to their durable steps", () => {
    const visualization = visualizeWorkflowSource(
      "automations/runtime-tools.workflow.js",
      `defineWorkflow({ name: "runtime-tools" }, async (event, step) => {
        const org = context.org(event.payload.orgId);
        const project = context.project(event.payload.projectId);
        const user = context.user(event.payload.userId);
        await step.do("configure", async () => {
          await internal.projectFilesConfigure({ projectId: event.payload.projectId });
          await org.internal.filesSeedExecute({});
          await project.internal.projectFilesConfigure({ projectId: event.payload.projectId });
          await user.internal.automationsRoutesSeedStarter({});
          await context.current.internal.automationsRoutesSeedStarter({});
          await something.internal.projectFilesConfigure({ projectId: "not-a-runtime-tool" });
        });
      });`,
    );
    const step = visualization.graph.nodes.find((node) => node.kind === "step");
    assert(step?.kind === "step");

    const callsByStepId = resolveWorkflowRuntimeToolCalls({
      visualization,
      catalog: internalCatalog,
    });

    expect(
      callsByStepId
        .get(step.id)
        ?.map((call) => ({ qualifiedName: call.tool.qualifiedName, scope: call.scope })),
    ).toEqual([
      { qualifiedName: "internal.projectFilesConfigure", scope: "current" },
      { qualifiedName: "internal.filesSeedExecute", scope: "org" },
      { qualifiedName: "internal.projectFilesConfigure", scope: "project" },
      { qualifiedName: "internal.automationsRoutesSeedStarter", scope: "user" },
      { qualifiedName: "internal.automationsRoutesSeedStarter", scope: "current" },
    ]);
  });

  it("links context-derived providers in the system workspace initialization workflow", () => {
    const path = SYSTEM_AUTOMATION_SCRIPT_PATHS.workspaceFileInitialization;
    const source = SYSTEM_AUTOMATION_CONTENT[path];
    assert(typeof source === "string");
    const visualization = visualizeWorkflowSource(path, source);
    const step = visualization.graph.nodes.find(
      (node) => node.kind === "step" && node.label === "seed workspace starter files",
    );
    assert(step?.kind === "step");

    const callsByStepId = resolveWorkflowRuntimeToolCalls({
      visualization,
      catalog: internalCatalog,
    });

    expect(
      callsByStepId
        .get(step.id)
        ?.map((call) => ({ qualifiedName: call.tool.qualifiedName, scope: call.scope })),
    ).toEqual([{ qualifiedName: "internal.filesSeedExecute", scope: "org" }]);
  });

  it("rejects duplicate source-level runtime-tool references", () => {
    expect(() =>
      createRuntimeToolWorkflowCatalog([internalToolFamily, internalToolFamily]),
    ).toThrow("share workflow reference 'internal.filesSeedExecute'");
  });
});
