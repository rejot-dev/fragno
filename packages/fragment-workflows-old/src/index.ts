import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { attachWorkflowsBindings } from "./bindings";
import { workflowsFragmentDefinition } from "./definition";
import { workflowsRoutesFactory } from "./routes";
import { workflowsSchema } from "./schema";
import { createWorkflowsRunner } from "./runner";
import type { WorkflowsFragmentConfig, WorkflowsRegistry } from "./workflow";

const routes = [workflowsRoutesFactory] as const;

/** Create a workflows fragment with routes, bindings, and database integration. */
export function createWorkflowsFragment<TRegistry extends WorkflowsRegistry>(
  config: WorkflowsFragmentConfig<TRegistry>,
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  const fragment = instantiate(workflowsFragmentDefinition)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(fragnoConfig)
    .build();

  return attachWorkflowsBindings(fragment, config.workflows ?? ({} as TRegistry));
}

export { workflowsFragmentDefinition };
export { workflowsRoutesFactory };
export { workflowsSchema };
export { createWorkflowsRunner };
export { attachWorkflowsBindings };
export { createWorkflowsClients } from "./client/clients";
export { defineWorkflow } from "./workflow";
export type { WorkflowContext, WorkflowDefinition } from "./workflow";
export * from "./workflow";
