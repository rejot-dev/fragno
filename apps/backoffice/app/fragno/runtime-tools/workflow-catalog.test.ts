import { assert, describe, expect, it } from "vitest";

import { visualizeWorkflowSource } from "@fragno-dev/workflow-visualizer-tokens";

import { adminMarketplacePublicationToolFamily } from "./families/admin-marketplace";
import { automationStoreToolFamily } from "./families/automations-bindings";
import {
  createRuntimeToolWorkflowCatalog,
  resolveWorkflowRuntimeToolCalls,
} from "./workflow-catalog";

const runtimeToolCatalog = createRuntimeToolWorkflowCatalog([
  adminMarketplacePublicationToolFamily,
  automationStoreToolFamily,
]);

describe("runtime-tool workflow catalog", () => {
  it("links direct and supported scoped provider calls to their durable steps", () => {
    const visualization = visualizeWorkflowSource(
      "automations/runtime-tools.workflow.js",
      `export default defineWorkflow({ name: "runtime-tools" }, async (event, step) => {
        const org = context.org(event.payload.orgId);
        const project = context.project(event.payload.projectId);
        const user = context.user(event.payload.userId);
        await step.do("configure", async () => {
          await store.get({ key: "current" });
          await org.store.get({ key: "org" });
          await project.store.get({ key: "project" });
          await user.store.get({ key: "settings" });
          await context.current.admin.marketplacePushStatic({});
          await something.store.get({ key: "unknown" });
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
      { qualifiedName: "store.get", scope: "current" },
      { qualifiedName: "store.get", scope: "org" },
      { qualifiedName: "store.get", scope: "project" },
      { qualifiedName: "store.get", scope: "user" },
      { qualifiedName: "admin.marketplacePushStatic", scope: "current" },
    ]);
  });

  it("rejects duplicate source-level runtime-tool references", () => {
    expect(() =>
      createRuntimeToolWorkflowCatalog([automationStoreToolFamily, automationStoreToolFamily]),
    ).toThrow("share workflow reference 'store.");
  });
});
