import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { attachWorkflowsBindings } from "./bindings";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { createWorkflowsRunner } from "./runner";
import type { WorkflowsFragmentConfig } from "./workflow";

const routes = [workflowsRoutesFactory] as const;

export function createWorkflowsFragment(
  config: WorkflowsFragmentConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();

  return attachWorkflowsBindings(fragment, config.workflows ?? {});
}

export { workflowsFragmentDefinition };
export { workflowsRoutesFactory };
export { workflowsSchema };
export { createWorkflowsRunner };
export { attachWorkflowsBindings };
export * from "./workflow";
