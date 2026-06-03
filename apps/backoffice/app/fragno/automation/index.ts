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
  AUTOMATION_BINDINGS_MANIFEST_PATH,
  AUTOMATION_SCRIPTS_ROOT,
  AUTOMATION_WORKSPACE_ROOT,
  createMinimalFileSystem,
  getAutomationBindingsForEvent,
  listAutomationWorkspaceScripts,
  loadAutomationCatalog,
  loadAutomationCatalogFromConfig,
  loadAutomationManifest,
  loadAutomationManifestSummary,
  readAutomationWorkspaceScript,
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
  AutomationManifest,
  AutomationManifestBinding,
  AutomationManifestBindingEntry,
  AutomationManifestScriptEntry,
  AutomationManifestSummary,
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
  createAutomationsRuntime,
  createRouteBackedAutomationsRuntime,
  createStorageBackedAutomationsRuntime,
  lookupAutomationIdentityBinding,
} from "./identity-runtime";
export { createEventBashRuntime } from "../bash-runtime/event-bash-runtime";
export { createOtpBashRuntime } from "../bash-runtime/otp-bash-runtime";
export {
  createTelegramBashRuntime,
  createUnavailableTelegramBashRuntime,
} from "../bash-runtime/telegram-bash-runtime";
export { createAutomationExecutionContext, createAutomationRuntime } from "./engine/runtime";
export { executeAutomationScript, executeBashAutomation } from "../bash-runtime/bash-host";
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
export type { AutomationsRuntime } from "../runtime-tools/families/automations";
export type { EventBashRuntime } from "../bash-runtime/event-bash-runtime";
export type { OtpBashRuntime } from "../bash-runtime/otp-bash-runtime";
export type {
  TelegramAutomationFileMetadata,
  TelegramBashRuntime,
} from "../bash-runtime/telegram-bash-runtime";
