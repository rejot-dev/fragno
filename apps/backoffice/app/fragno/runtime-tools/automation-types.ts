import type {
  AutomationEvent,
  AutomationEventActor,
  AutomationExternalEntityRef,
} from "../automation/contracts";
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
  actor: AutomationExternalEntityRef;
  ttlMinutes?: number;
};

export type StoreGetArgs = {
  key: string;
};

export type StoreVerification = {
  type: "json-schema";
  schema: unknown;
};

export type StoreSetArgs = {
  key: string;
  value: string;
  actor: AutomationEventActor | null;
  description?: string | null;
  category?: string[];
  verification?: StoreVerification[];
};

export type StoreListArgs = {
  prefix?: string;
  limit?: number;
};

export type StoreDeleteArgs = {
  key: string;
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
