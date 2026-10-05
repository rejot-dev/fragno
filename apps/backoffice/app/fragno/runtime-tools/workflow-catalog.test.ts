import { assert, describe, expect, it } from "vitest";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import {
  SYSTEM_AUTOMATION_CONTENT,
  SYSTEM_AUTOMATION_SCRIPT_PATHS,
} from "@/files/content/system-automations";

import { automationStoreToolFamily } from "./families/automations-bindings";
import { internalMarketplaceToolFamily, internalWorkspaceToolFamily } from "./families/internal";
import {
  createRuntimeToolWorkflowCatalog,
  resolveWorkflowRuntimeToolCalls,
} from "./workflow-catalog";

const runtimeToolCatalog = createRuntimeToolWorkflowCatalog([
  internalWorkspaceToolFamily,
  internalMarketplaceToolFamily,
  automationStoreToolFamily,
]);

describe("runtime-tool workflow catalog", () => {
  it("links direct and supported scoped provider calls to their durable steps", () => {
    const visualization = visualizeWorkflowSource(
      "automations/runtime-tools.workflow.js",
      `defineWorkflow({ name: "runtime-tools" }, async (event, step) => {
        const org = context.org(event.payload.orgId);
        const project = context.project(event.payload.projectId);
        const user = context.user(event.payload.userId);
        await step.do("configure", async () => {
          await internal.filesSeedExecute({});
          await org.internal.filesSeedExecute({});
          await project.internal.filesSeedExecute({});
          await user.store.get({ key: "settings" });
          await context.current.internal.marketplacePush({});
          await something.internal.filesSeedExecute({});
        });
      });`,
    );
    const step = visualization.graph.nodes.find((node) => node.kind === "step");
    assert(step?.kind === "step");

    const callsByStepId = resolveWorkflowRuntimeToolCalls({
      visualization,
      catalog: runtimeToolCatalog,
    });

    expect(
      callsByStepId
        .get(step.id)
        ?.map((call) => ({ qualifiedName: call.tool.qualifiedName, scope: call.scope })),
    ).toEqual([
      { qualifiedName: "internal.filesSeedExecute", scope: "current" },
      { qualifiedName: "internal.filesSeedExecute", scope: "org" },
      { qualifiedName: "internal.filesSeedExecute", scope: "project" },
      { qualifiedName: "store.get", scope: "user" },
      { qualifiedName: "internal.marketplacePush", scope: "current" },
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
      catalog: runtimeToolCatalog,
    });

    expect(
      callsByStepId
        .get(step.id)
        ?.map((call) => ({ qualifiedName: call.tool.qualifiedName, scope: call.scope })),
    ).toEqual([{ qualifiedName: "internal.filesSeedExecute", scope: "org" }]);
  });

  it("rejects duplicate source-level runtime-tool references", () => {
    expect(() =>
      createRuntimeToolWorkflowCatalog([internalWorkspaceToolFamily, internalWorkspaceToolFamily]),
    ).toThrow("share workflow reference 'internal.filesSeedExecute'");
  });
});
