import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  automationFragmentDefinition,
  type AutomationFragmentConfig,
  type AutomationIngestResult,
  type AutomationWorkflowsService,
} from "./definition";
import { automationEventRoutes } from "./event-routes";
import { automationProjectRoutes } from "./project-routes";
import type { AutomationProjectExecutionTarget } from "./projects";
import { automationRouteRoutes } from "./route-routes";
import type {
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxInstanceStatus,
  SandboxProvider,
} from "./sandboxes";
import { automationStoreRoutes } from "./store-routes";

type AutomationFragmentServices = {
  workflows: AutomationWorkflowsService;
};

export function createAutomationFragment(
  config: AutomationFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
  services: AutomationFragmentServices,
) {
  return instantiate(automationFragmentDefinition)
    .withConfig(config)
    .withRoutes([
      automationProjectRoutes,
      automationRouteRoutes,
      automationStoreRoutes,
      automationEventRoutes,
    ])
    .withOptions(options)
    .withServices(services)
    .build();
}

export type { AutomationFragmentConfig };
export {
  AUTOMATION_STATIC_ROOT,
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationLayerForPath,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
} from "./catalog";
export type { AutomationScriptLayer, AutomationWorkspaceScriptEntry } from "./catalog";
export type { AutomationEventRecord } from "./events";
export {
  STARTER_AUTOMATION_ROUTES,
  SYSTEM_STARTER_AUTOMATION_ROUTES,
} from "./content/starter-routing";
export type { AutomationRouteDefinition, StarterAutomationRoutesSeedResult } from "./routing";

export { CLOUDFLARE_SANDBOX_PROVIDER } from "./sandboxes";
export type {
  AutomationIngestResult,
  AutomationProjectExecutionTarget,
  SandboxInstanceRecord,
  SandboxInstanceRequestInput,
  SandboxInstanceStatus,
  SandboxProvider,
};
export type { AutomationEvent, AutomationEventActor, AutomationEventSubject } from "./contracts";

export type { AutomationRuntimeHostContext, AutomationRuntime } from "./engine/runtime";
