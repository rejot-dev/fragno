import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import {
  automationFragmentDefinition,
  type AutomationFragmentConfig,
  type AutomationIngestResult,
  type AutomationWorkflowsService,
} from "./definition";
import type { AutomationProjectExecutionTarget } from "./projects";
import { automationFragmentRoutes } from "./routes";

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
    .withRoutes([automationFragmentRoutes])
    .withOptions(options)
    .withServices(services)
    .build();
}

export type { AutomationFragmentConfig };
export {
  AUTOMATION_SYSTEM_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  listAutomationWorkspaceScripts,
  readAutomationWorkspaceScript,
} from "./catalog";
export type { AutomationScriptLayer, AutomationWorkspaceScriptEntry } from "./catalog";

export type { AutomationIngestResult, AutomationProjectExecutionTarget };
export type { AutomationEvent, AutomationEventActor, AutomationEventSubject } from "./contracts";

export type { AutomationRuntimeHostContext, AutomationRuntime } from "./engine/runtime";
