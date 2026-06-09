import type { AutomationEvent } from "../automation/contracts";
import type { AutomationCommandCallResult } from "../automation/run-result";

export type AutomationCommandFormat = "text" | "json";

export type AutomationCommandOutputOptions = {
  format: AutomationCommandFormat;
  print?: string;
};

export type AutomationCommandExecutionResult<TData = unknown> = {
  data?: TData;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  stdoutEncoding?: "binary";
};

export type IdentityCreateClaimArgs = {
  source: string;
  externalActorId: string;
  ttlMinutes?: number;
};

export type IdentityLookupBindingArgs = {
  source: string;
  key: string;
};

export type IdentityBindActorArgs = {
  source: string;
  key: string;
  value: string;
  description?: string;
};

export type EventEmitArgs = {
  eventType: string;
  source?: string;
  externalActorId?: string;
  actorType?: string;
  subjectUserId?: string;
  payload?: Record<string, unknown>;
};

export type AutomationCommandOptionSpec = {
  name: string;
  description: string;
  required?: boolean;
  valueName?: string;
  valueRequired?: boolean;
};

export type AutomationCommandHelp = {
  summary: string;
  options: readonly AutomationCommandOptionSpec[];
  examples?: readonly string[];
};

export type BashAutomationCommandResult = AutomationCommandCallResult;

export type AutomationTriggerBinding = {
  id?: string;
  source: string;
  eventType: string;
  scriptId: string;
  scriptKey?: string;
  scriptName?: string;
  scriptPath?: string;
  scriptVersion?: number;
  /** Default sentinel sorts last among bindings for the same event. */
  triggerOrder?: number;
};

export type AutomationCommandContext = {
  event: AutomationEvent;
  orgId: string | undefined;
  binding: AutomationTriggerBinding;
  idempotencyKey: string;
};
