import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import type {
  AutomationCreateIdentityClaimInput,
  AutomationCreateIdentityClaimResult,
  AutomationEvent,
  AutomationEventActor,
  AutomationEventPayload,
  AutomationEventSubject,
  AutomationSourceAdapter,
  AutomationSourceAdapterRegistry,
} from "./contracts";
import {
  automationFragmentDefinition,
  type AutomationFragmentConfig,
  type AutomationIngestResult,
  type AutomationWorkflowsService,
} from "./definition";
import { automationFragmentRoutes } from "./routes";

type AutomationFragmentServices = {
  workflows: AutomationWorkflowsService;
};

export function createAutomationFragment(
  config: AutomationFragmentConfig = {},
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

export { automationFragmentDefinition } from "./definition";
export { automationFragmentSchema } from "./schema";
export type { AutomationFragmentConfig };
export {
  builtinAutomationBindings,
  builtinAutomationScripts,
  telegramClaimLinkingCompleteScript,
  telegramClaimLinkingStartScript,
} from "./builtins";
export type { AutomationBuiltinScript, AutomationBuiltinTriggerBinding } from "./builtins";
export { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES } from "./contracts";
export type { AutomationEvent, AutomationIngestResult };
export type {
  AutomationCreateIdentityClaimInput,
  AutomationCreateIdentityClaimResult,
  AutomationEventActor,
  AutomationEventPayload,
  AutomationEventSubject,
  AutomationKnownEvent,
  AutomationKnownEventType,
  AutomationEventTypeForSource,
  AutomationSource,
  AutomationSourceAdapter,
  AutomationSourceAdapterRegistry,
} from "./contracts";
