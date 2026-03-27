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
export { automationFragmentSchema, AUTOMATION_TRIGGER_ORDER_LAST } from "./schema";
export type { AutomationFragmentConfig, AutomationPiBashContext };
export {
  AUTOMATION_BINDINGS_MANIFEST_PATH,
  AUTOMATION_SCRIPTS_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  createMinimalFileSystem,
  getAutomationBindingsForEvent,
  loadAutomationCatalog,
  loadAutomationCatalogFromConfig,
  resolveAutomationFileSystem,
} from "./catalog";
export {
  AUTOMATION_SIMULATION_ROOT,
  AUTOMATION_SIMULATION_SCENARIOS_ROOT,
  automationScenarioSchema,
  defineAutomationScenario,
  listAutomationScenarios,
  loadAutomationScenarioFile,
  resolveAutomationScenarioPath,
  runAutomationScenarioFile,
  simulateAutomationScenario,
} from "./scenario";
export type {
  AutomationBindingCatalogEntry,
  AutomationCatalog,
  AutomationFileSystemConfig,
  AutomationFileSystemResolvePurpose,
  AutomationFileSystemResolver,
  AutomationFileSystemResolverInput,
  AutomationScriptCatalogEntry,
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
  AutomationSourceAdapter,
  AutomationSourceAdapterRegistry,
} from "./contracts";
export type {
  AutomationScenarioCatalogEntry,
  AutomationScenarioCatalogStepEntry,
  AutomationScenarioCommandMock,
  AutomationScenarioCommandName,
  AutomationScenarioDefinition,
  AutomationScenarioMockResult,
  AutomationScenarioStep,
  AutomationSimulationBindingTranscript,
  AutomationSimulationClaim,
  AutomationSimulationCommandTranscript,
  AutomationSimulationIdentityBinding,
  AutomationSimulationPiSession,
  AutomationSimulationReply,
  AutomationSimulationResult,
  AutomationSimulationState,
  AutomationSimulationStepTranscript,
  RunAutomationScenarioFileOptions,
  SimulateAutomationScenarioOptions,
} from "./scenario";
export {
  bindAutomationIdentityActor,
  createAutomationsBashRuntime,
  createRouteBackedAutomationsBashRuntime,
  createStorageBackedAutomationsBashRuntime,
  lookupAutomationIdentityBinding,
} from "../bash-runtime/automations-bash-runtime";
export { createEventBashRuntime } from "../bash-runtime/event-bash-runtime";
export { createOtpBashRuntime } from "../bash-runtime/otp-bash-runtime";
export {
  createTelegramBashRuntime,
  createUnavailableTelegramBashRuntime,
} from "../bash-runtime/telegram-bash-runtime";
export { createAutomationBashCommandContext, createAutomationBashRuntime } from "./engine/bash";
export { executeBashAutomation } from "../bash-runtime/bash-host";
export type {
  AutomationBashCommandContext,
  AutomationBashHostContext,
  AutomationBashRuntime,
  AutomationEmitEventResult,
  AutomationIdentityBindingRecord,
} from "./engine/bash";
export type { AutomationsBashRuntime } from "../bash-runtime/automations-bash-runtime";
export type { AutomationReplyResult, EventBashRuntime } from "../bash-runtime/event-bash-runtime";
export type { OtpBashRuntime } from "../bash-runtime/otp-bash-runtime";
export type {
  TelegramAutomationFileMetadata,
  TelegramBashRuntime,
} from "../bash-runtime/telegram-bash-runtime";
