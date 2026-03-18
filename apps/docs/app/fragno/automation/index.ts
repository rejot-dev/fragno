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
  type AutomationPiBashContext,
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
export type { AutomationFragmentConfig, AutomationPiBashContext };
export {
  builtinAutomationBindings,
  builtinAutomationScripts,
  telegramClaimLinkingCompleteScript,
  telegramClaimLinkingStartScript,
  telegramCreatePiSessionScript,
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
export {
  bindAutomationIdentityActor,
  createAutomationsBashRuntime,
  createRouteBackedAutomationsBashRuntime,
  createStorageBackedAutomationsBashRuntime,
  lookupAutomationIdentityBinding,
} from "./automations-bash-runtime";
export { createEventBashRuntime } from "./event-bash-runtime";
export { createOtpBashRuntime } from "./otp-bash-runtime";
export {
  createAutomationBashCommandContext,
  createAutomationBashRuntime,
  executeBashAutomation,
} from "./engine/bash";
export type {
  AutomationBashCommandContext,
  AutomationBashHostContext,
  AutomationBashRuntime,
  AutomationEmitEventResult,
  AutomationIdentityBindingRecord,
  AutomationIdentityClaimRecord,
} from "./engine/bash";
export type { AutomationsBashRuntime } from "./automations-bash-runtime";
export type { AutomationReplyResult, EventBashRuntime } from "./event-bash-runtime";
export type { OtpBashRuntime } from "./otp-bash-runtime";
