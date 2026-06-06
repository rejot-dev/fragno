import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import type {
  AutomationCreateIdentityClaimInput,
  AutomationCreateIdentityClaimResult,
  AutomationEvent,
  AutomationEventActor,
  AutomationEventPayload,
  AutomationEventSubject,
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
export { automationFragmentSchema, AUTOMATION_TRIGGER_ORDER_LAST } from "./schema";
export type { AutomationFragmentConfig, AutomationPiBashContext };
export {
  AUTOMATION_SCRIPTS_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  createMinimalFileSystem,
  getAutomationBindingsForEvent,
  listAutomationWorkspaceScripts,
  loadAutomationCatalog,
  loadAutomationCatalogFromConfig,
  readAutomationWorkspaceScript,
  resolveAutomationFileSystem,
} from "./catalog";
export type {
  AutomationBindingCatalogEntry,
  AutomationCatalog,
  AutomationFileSystemConfig,
  AutomationFileSystemResolvePurpose,
  AutomationFileSystemResolver,
  AutomationFileSystemResolverInput,
  AutomationScriptCatalogEntry,
  AutomationWorkspaceScriptEntry,
} from "./catalog";
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
} from "./contracts";
export {
  bindAutomationIdentityActor,
  createAutomationBindingsRuntime,
  createStorageBackedAutomationBindingsRuntime,
  lookupAutomationIdentityBinding,
} from "./bindings-storage-runtime";
export { createRouteBackedAutomationBindingsRuntime } from "./bindings-route-runtime";
export { createRouteBackedAutomationWorkflowRuntime } from "./workflow-route-runtime";
export { createEventRuntime } from "../runtime-tools/families/event-runtime";
export { createOtpRuntime } from "../runtime-tools/families/otp-runtime";
export {
  createTelegramRuntime,
  createUnavailableTelegramRuntime,
} from "../runtime-tools/families/telegram-runtime";
export { createAutomationExecutionContext, createAutomationRuntime } from "./engine/runtime";
export { executeAutomationScript, executeBashAutomation } from "../runtime-tools/automation-host";
export { createAutomationRunResult, formatAutomationResultAsStdout } from "./run-result";
export type {
  AutomationRuntimeCommandContext,
  AutomationRuntimeHostContext,
  AutomationRuntime,
  AutomationEmitEventResult,
  AutomationIdentityBindingRecord,
} from "./engine/runtime";
export type {
  AutomationCommandCallResult,
  AutomationRunResult,
  AutomationRunRuntime,
} from "./run-result";
export type { AutomationBindingsRuntime } from "../runtime-tools/families/automations-bindings";
export type { EventRuntime } from "../runtime-tools/families/event-runtime";
export type { OtpRuntime } from "../runtime-tools/families/otp-runtime";
export type {
  TelegramAutomationFileMetadata,
  TelegramRuntime,
} from "../runtime-tools/families/telegram-runtime";
