import { Bash, InMemoryFs, defineCommand } from "just-bash";
import { z } from "zod";

import type { IFileSystem } from "@/files";

import { PI_COMMAND_SPEC_LIST, type PiParsedCommandByName } from "../bash-runtime/pi-bash-runtime";
import {
  AUTOMATION_WORKSPACE_ROOT,
  getAutomationBindingsForEvent,
  loadAutomationCatalog,
  type AutomationBindingCatalogEntry,
} from "./catalog";
import {
  buildCommandHelp,
  ensureTrailingNewline,
  formatCommandStdout,
  hasHelpOption,
  normalizeExecutionResult,
  parseCliTokens,
} from "./commands/cli";
import {
  AUTOMATIONS_COMMAND_SPEC_LIST,
  EVENT_COMMAND_SPEC_LIST,
  OTP_COMMAND_SPEC_LIST,
} from "./commands/registry";
import type {
  AutomationCommandExecutionResult,
  AutomationCommandOutputOptions,
  AutomationCommandSpec,
  ParsedCommandByName,
} from "./commands/types";
import type { AutomationEvent } from "./contracts";

export const AUTOMATION_SIMULATION_ROOT = `${AUTOMATION_WORKSPACE_ROOT}/simulator`;
export const AUTOMATION_SIMULATION_SCENARIOS_ROOT = `${AUTOMATION_SIMULATION_ROOT}/scenarios`;

export type AutomationSimulationIdentityBinding = {
  id?: string;
  source: string;
  key: string;
  value: string;
  description?: string | null;
  status: string;
  linkedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type AutomationSimulationClaim = {
  id?: string;
  source: string;
  externalActorId: string;
  url: string;
  code: string;
  type?: string;
  expiresAt?: string;
  [key: string]: unknown;
};

export type AutomationSimulationPiSession = {
  id: string;
  agent: string;
  name?: string | null;
  status: string;
  steeringMode?: string;
  metadata?: unknown;
  tags?: string[];
  workflow?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type AutomationSimulationReply = {
  eventId: string;
  source: string;
  externalActorId: string;
  text: string;
  [key: string]: unknown;
};

export type AutomationSimulationState = {
  identityBindings: AutomationSimulationIdentityBinding[];
  claims: AutomationSimulationClaim[];
  piSessions: AutomationSimulationPiSession[];
  replies: AutomationSimulationReply[];
  emittedEvents: AutomationEvent[];
  counters: {
    claims: number;
    piSessions: number;
    emittedEvents: number;
  };
};

export type AutomationScenarioMockResult = {
  data?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
};

export type AutomationScenarioCommandMock = {
  results: AutomationScenarioMockResult[];
  onExhausted: "default" | "repeat-last" | "error";
};

export type AutomationScenarioCommandName = keyof ParsedCommandByName | keyof PiParsedCommandByName;

export type AutomationScenarioDefinition = {
  version: 1;
  name: string;
  description?: string;
  env?: Record<string, string>;
  initialState?: Partial<AutomationSimulationState>;
  commandMocks?: Partial<Record<AutomationScenarioCommandName, AutomationScenarioCommandMock>>;
  steps: AutomationScenarioStep[];
  expectations?: unknown;
  examples?: unknown;
  [key: string]: unknown;
};

export type AutomationScenarioStep = {
  id?: string;
  title?: string;
  event: AutomationEvent;
  env?: Record<string, string>;
  expectations?: unknown;
  example?: unknown;
  [key: string]: unknown;
};

export type AutomationSimulationCommandTranscript = {
  index: number;
  name: AutomationScenarioCommandName;
  rawArgs: string[];
  args: unknown | null;
  output: AutomationCommandOutputOptions | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  resolution:
    | { kind: "builtin" }
    | { kind: "mock"; strategy: "sequence" | "repeat-last"; callIndex: number; resultIndex: number }
    | { kind: "mock-fallback"; callIndex: number };
};

export type AutomationSimulationBindingTranscript = {
  index: number;
  bindingId: string;
  scriptId: string;
  scriptPath: string;
  triggerOrder: number | null;
  status: "completed" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  commands: AutomationSimulationCommandTranscript[];
};

export type AutomationSimulationStepTranscript = {
  index: number;
  id: string;
  title?: string;
  event: AutomationEvent;
  matchedBindingIds: string[];
  status: "completed" | "failed";
  bindingRuns: AutomationSimulationBindingTranscript[];
  failure?: {
    bindingId: string;
    scriptId: string;
    exitCode: number;
    message: string;
  };
};

export type AutomationSimulationResult = {
  scenario: AutomationScenarioDefinition;
  transcript: {
    steps: AutomationSimulationStepTranscript[];
    totalBindingsRun: number;
    totalCommandsRun: number;
  };
  finalState: AutomationSimulationState;
};

export type AutomationScenarioSourceEnvProjector = (
  event: AutomationEvent,
) => Record<string, string | undefined>;

export type SimulateAutomationScenarioOptions = {
  fileSystem: IFileSystem;
  scenario: AutomationScenarioDefinition;
  sourceEnvProjectors?: Partial<Record<string, AutomationScenarioSourceEnvProjector>>;
};

export type RunAutomationScenarioFileOptions = {
  fileSystem: IFileSystem;
  path: string;
  sourceEnvProjectors?: Partial<Record<string, AutomationScenarioSourceEnvProjector>>;
};

type ScenarioParsedCommandByName = ParsedCommandByName & PiParsedCommandByName;
type ScenarioParsedCommand = ScenarioParsedCommandByName[keyof ScenarioParsedCommandByName];
type ScenarioCommandSpec = AutomationCommandSpec<
  AutomationScenarioCommandName,
  ScenarioParsedCommandByName[AutomationScenarioCommandName]["args"]
> & {
  parse: (args: string[]) => ScenarioParsedCommandByName[AutomationScenarioCommandName];
};

type MockResolution = AutomationSimulationCommandTranscript["resolution"];

type MockCursorState = Partial<Record<AutomationScenarioCommandName, number>>;

type CommandExecutionContext = {
  event: AutomationEvent;
  binding: AutomationBindingCatalogEntry;
  state: AutomationSimulationState;
  commandMocks: AutomationScenarioDefinition["commandMocks"];
  mockCursorState: MockCursorState;
};

const SUPPORTED_COMMAND_SPECS = [
  ...AUTOMATIONS_COMMAND_SPEC_LIST,
  ...OTP_COMMAND_SPEC_LIST,
  ...EVENT_COMMAND_SPEC_LIST,
  ...PI_COMMAND_SPEC_LIST,
] as readonly ScenarioCommandSpec[];

const automationEventSchema: z.ZodType<AutomationEvent> = z.object({
  id: z.string().trim().min(1),
  orgId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  occurredAt: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  actor: z
    .object({
      type: z.string().trim().min(1),
      externalId: z.string().trim().min(1),
    })
    .passthrough()
    .nullish(),
  subject: z
    .object({
      orgId: z.string().trim().min(1).optional(),
      userId: z.string().trim().min(1).optional(),
    })
    .passthrough()
    .nullish(),
});

const identityBindingSchema: z.ZodType<AutomationSimulationIdentityBinding> = z
  .object({
    id: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1),
    key: z.string().trim().min(1),
    value: z.string(),
    description: z.string().nullable().optional(),
    status: z.string().default("linked"),
    linkedAt: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const claimSchema: z.ZodType<AutomationSimulationClaim> = z
  .object({
    id: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1),
    externalActorId: z.string().trim().min(1),
    url: z.string().trim().min(1),
    code: z.string().trim().min(1),
    type: z.string().optional(),
    expiresAt: z.string().optional(),
  })
  .passthrough();

const piSessionSchema: z.ZodType<AutomationSimulationPiSession> = z
  .object({
    id: z.string().trim().min(1),
    agent: z.string().trim().min(1),
    name: z.string().nullable().optional(),
    status: z.string().trim().min(1),
    steeringMode: z.string().optional(),
    metadata: z.unknown().optional(),
    tags: z.array(z.string()).optional(),
    workflow: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

const replySchema: z.ZodType<AutomationSimulationReply> = z
  .object({
    eventId: z.string().trim().min(1),
    source: z.string().trim().min(1),
    externalActorId: z.string().trim().min(1),
    text: z.string(),
  })
  .passthrough();

const stateSchema = z.object({
  identityBindings: z.array(identityBindingSchema).default([]),
  claims: z.array(claimSchema).default([]),
  piSessions: z.array(piSessionSchema).default([]),
  replies: z.array(replySchema).default([]),
  emittedEvents: z.array(automationEventSchema).default([]),
  counters: z
    .object({
      claims: z.number().int().nonnegative().default(0),
      piSessions: z.number().int().nonnegative().default(0),
      emittedEvents: z.number().int().nonnegative().default(0),
    })
    .default({
      claims: 0,
      piSessions: 0,
      emittedEvents: 0,
    }),
});

const mockResultSchema: z.ZodType<AutomationScenarioMockResult> = z
  .object({
    data: z.unknown().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
  })
  .passthrough();

const commandMockSchema: z.ZodType<AutomationScenarioCommandMock> = z.object({
  results: z.array(mockResultSchema).default([]),
  onExhausted: z.enum(["default", "repeat-last", "error"]).default("default"),
});

const scenarioCommandMocksSchema = z
  .object({
    "automations.identity.lookup-binding": commandMockSchema.optional(),
    "automations.identity.bind-actor": commandMockSchema.optional(),
    "otp.identity.create-claim": commandMockSchema.optional(),
    "event.reply": commandMockSchema.optional(),
    "event.emit": commandMockSchema.optional(),
    "pi.session.create": commandMockSchema.optional(),
    "pi.session.get": commandMockSchema.optional(),
    "pi.session.list": commandMockSchema.optional(),
  })
  .partial();

const scenarioStepSchema: z.ZodType<AutomationScenarioStep> = z
  .object({
    id: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
    event: automationEventSchema,
    env: z.record(z.string(), z.string()).optional(),
    expectations: z.unknown().optional(),
    example: z.unknown().optional(),
  })
  .passthrough();

export const automationScenarioSchema: z.ZodType<AutomationScenarioDefinition> = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
    initialState: stateSchema.partial().default({}),
    commandMocks: scenarioCommandMocksSchema.default({}),
    steps: z.array(scenarioStepSchema).min(1),
    expectations: z.unknown().optional(),
    examples: z.unknown().optional(),
  })
  .passthrough();

const clone = <T>(value: T): T => structuredClone(value);

const formatScenarioSchemaError = (error: z.ZodError) =>
  error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");

const parseScenario = (input: unknown): AutomationScenarioDefinition => {
  const result = automationScenarioSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Automation scenario is invalid: ${formatScenarioSchemaError(result.error)}`);
  }

  return result.data;
};

const normalizeSimulationState = (
  input: Partial<AutomationSimulationState> | undefined,
): AutomationSimulationState => {
  const result = stateSchema.parse(input ?? {});
  return {
    identityBindings: clone(result.identityBindings),
    claims: clone(result.claims),
    piSessions: clone(result.piSessions).map((session) => ensurePiSessionShape(session)),
    replies: clone(result.replies),
    emittedEvents: clone(result.emittedEvents),
    counters: {
      claims: result.counters.claims,
      piSessions: result.counters.piSessions,
      emittedEvents: result.counters.emittedEvents,
    },
  };
};

const nextCounter = (
  state: AutomationSimulationState,
  key: keyof AutomationSimulationState["counters"],
) => {
  state.counters[key] += 1;
  return state.counters[key];
};

const findIdentityBindingIndex = (state: AutomationSimulationState, source: string, key: string) =>
  state.identityBindings.findIndex((binding) => binding.source === source && binding.key === key);

const upsertIdentityBinding = (
  state: AutomationSimulationState,
  input: Partial<AutomationSimulationIdentityBinding> & {
    source: string;
    key: string;
    value: string;
  },
  occurredAt: string,
) => {
  const existingIndex = findIdentityBindingIndex(state, input.source, input.key);
  const existing = existingIndex >= 0 ? state.identityBindings[existingIndex] : undefined;
  const record: AutomationSimulationIdentityBinding = {
    ...(existing ? clone(existing) : {}),
    ...clone(input),
    id: typeof input.id === "string" ? input.id : existing?.id,
    source: input.source,
    key: input.key,
    value: input.value,
    description:
      typeof input.description === "string"
        ? input.description
        : input.description === null
          ? null
          : (existing?.description ?? null),
    status: typeof input.status === "string" && input.status.trim() ? input.status : "linked",
    linkedAt:
      typeof input.linkedAt === "string"
        ? input.linkedAt
        : (existing?.linkedAt ?? (recordHasLinkedStatus(input.status) ? occurredAt : undefined)),
    createdAt:
      typeof input.createdAt === "string" ? input.createdAt : (existing?.createdAt ?? occurredAt),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : occurredAt,
  };

  if (existingIndex >= 0) {
    state.identityBindings.splice(existingIndex, 1, record);
  } else {
    state.identityBindings.push(record);
  }

  return record;
};

const recordHasLinkedStatus = (status: string | undefined) =>
  (status?.trim() || "linked") === "linked";

const getNestedStatus = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const workflow = (value as { workflow?: unknown }).workflow;
  if (!workflow || typeof workflow !== "object") {
    return undefined;
  }

  const status = (workflow as { status?: unknown }).status;
  return typeof status === "string" && status.trim() ? status : undefined;
};

const ensurePiSessionShape = (
  session: AutomationSimulationPiSession,
): AutomationSimulationPiSession => {
  const cloned = clone(session);
  const workflow =
    cloned.workflow && typeof cloned.workflow === "object" ? clone(cloned.workflow) : {};
  const workflowStatus = getNestedStatus(cloned);
  const status =
    typeof cloned.status === "string" && cloned.status.trim()
      ? cloned.status
      : (workflowStatus ?? "waiting");

  if (typeof workflow.status !== "string" || !workflow.status.trim()) {
    workflow.status = status;
  }

  return {
    ...cloned,
    status,
    workflow,
    tags: Array.isArray(cloned.tags) ? cloned.tags.map((tag) => String(tag)) : [],
  };
};

const upsertPiSession = (
  state: AutomationSimulationState,
  session: AutomationSimulationPiSession,
) => {
  const normalized = ensurePiSessionShape(session);
  const existingIndex = state.piSessions.findIndex((entry) => entry.id === normalized.id);

  if (existingIndex >= 0) {
    state.piSessions.splice(existingIndex, 1, normalized);
  } else {
    state.piSessions.push(normalized);
  }

  return normalized;
};

const getCommandMock = (
  context: CommandExecutionContext,
  name: AutomationScenarioCommandName,
): { resolution: MockResolution; result: AutomationScenarioMockResult | null } => {
  const commandMock = context.commandMocks?.[name];
  if (!commandMock) {
    return {
      resolution: { kind: "builtin" },
      result: null,
    };
  }

  const callIndex = context.mockCursorState[name] ?? 0;
  context.mockCursorState[name] = callIndex + 1;

  if (callIndex < commandMock.results.length) {
    return {
      resolution: {
        kind: "mock",
        strategy: "sequence",
        callIndex,
        resultIndex: callIndex,
      },
      result: clone(commandMock.results[callIndex]!),
    };
  }

  if (commandMock.onExhausted === "repeat-last" && commandMock.results.length > 0) {
    return {
      resolution: {
        kind: "mock",
        strategy: "repeat-last",
        callIndex,
        resultIndex: commandMock.results.length - 1,
      },
      result: clone(commandMock.results.at(-1)!),
    };
  }

  if (commandMock.onExhausted === "error") {
    throw new Error(
      `Automation scenario mock for '${name}' has no configured result for call ${callIndex + 1}.`,
    );
  }

  return {
    resolution: {
      kind: "mock-fallback",
      callIndex,
    },
    result: null,
  };
};

const createDefaultClaim = (
  state: AutomationSimulationState,
  event: AutomationEvent,
  args: { source: string; externalActorId: string },
): AutomationSimulationClaim => {
  const claimIndex = nextCounter(state, "claims");
  return {
    id: `claim-${claimIndex}`,
    source: args.source,
    externalActorId: args.externalActorId,
    url: `https://example.test/claims/${encodeURIComponent(args.externalActorId)}`,
    code: String(100000 + claimIndex),
    type: "otp",
    expiresAt: event.occurredAt,
  };
};

const normalizeClaimFromData = (
  state: AutomationSimulationState,
  event: AutomationEvent,
  args: { source: string; externalActorId: string },
  data: unknown,
): AutomationSimulationClaim => {
  const fallback = createDefaultClaim(state, event, args);
  if (!data || typeof data !== "object") {
    return fallback;
  }

  const record = clone(data as Record<string, unknown>);
  return {
    ...fallback,
    ...record,
    source: typeof record.source === "string" && record.source.trim() ? record.source : args.source,
    externalActorId:
      typeof record.externalId === "string" && record.externalId.trim()
        ? record.externalId
        : args.externalActorId,
    url: typeof record.url === "string" && record.url.trim() ? record.url : fallback.url,
    code: typeof record.code === "string" && record.code.trim() ? record.code : fallback.code,
    type: typeof record.type === "string" && record.type.trim() ? record.type : fallback.type,
    expiresAt:
      typeof record.expiresAt === "string" && record.expiresAt.trim()
        ? record.expiresAt
        : fallback.expiresAt,
  };
};

const createDefaultPiSession = (
  state: AutomationSimulationState,
  event: AutomationEvent,
  args: {
    agent: string;
    name?: string;
    steeringMode?: string;
    metadata?: unknown;
    tags?: string[];
  },
): AutomationSimulationPiSession => {
  const sessionIndex = nextCounter(state, "piSessions");
  return ensurePiSessionShape({
    id: `sim-session-${sessionIndex}`,
    agent: args.agent,
    name: args.name ?? null,
    status: "waiting",
    steeringMode: args.steeringMode ?? "one-at-a-time",
    metadata: clone(args.metadata ?? null),
    tags: clone(args.tags ?? []),
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    workflow: {
      status: "waiting",
    },
  });
};

const createDefaultEmittedEvent = (
  state: AutomationSimulationState,
  event: AutomationEvent,
  args: {
    eventType: string;
    source?: string;
    externalActorId?: string;
    actorType?: string;
    subjectUserId?: string;
    payload?: Record<string, unknown>;
  },
): AutomationEvent => {
  const eventIndex = nextCounter(state, "emittedEvents");
  return {
    id: `sim-emitted-${eventIndex}`,
    orgId: event.orgId,
    source: args.source ?? event.source,
    eventType: args.eventType,
    occurredAt: event.occurredAt,
    payload: clone(args.payload ?? {}),
    actor: args.externalActorId
      ? {
          type: args.actorType ?? event.actor?.type ?? "external",
          externalId: args.externalActorId,
        }
      : null,
    subject: args.subjectUserId ? { userId: args.subjectUserId } : null,
  };
};

const normalizePiSessionFromData = (
  state: AutomationSimulationState,
  event: AutomationEvent,
  args: {
    agent: string;
    name?: string;
    steeringMode?: string;
    metadata?: unknown;
    tags?: string[];
  },
  data: unknown,
): AutomationSimulationPiSession => {
  if (!data || typeof data !== "object") {
    return createDefaultPiSession(state, event, args);
  }

  const record = clone(data as Record<string, unknown>);
  const fallback = createDefaultPiSession(state, event, args);

  return ensurePiSessionShape({
    ...fallback,
    ...record,
    id: typeof record.id === "string" && record.id.trim() ? record.id : fallback.id,
    agent: typeof record.agent === "string" && record.agent.trim() ? record.agent : fallback.agent,
    name:
      typeof record.name === "string" || record.name === null
        ? (record.name as string | null)
        : fallback.name,
    status:
      typeof record.status === "string" && record.status.trim()
        ? record.status
        : (getNestedStatus(record) ?? fallback.status),
    steeringMode:
      typeof record.steeringMode === "string" && record.steeringMode.trim()
        ? record.steeringMode
        : fallback.steeringMode,
    metadata: "metadata" in record ? clone(record.metadata) : fallback.metadata,
    tags: Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : fallback.tags,
    workflow:
      record.workflow && typeof record.workflow === "object"
        ? clone(record.workflow as Record<string, unknown>)
        : fallback.workflow,
    createdAt:
      typeof record.createdAt === "string" && record.createdAt.trim()
        ? record.createdAt
        : fallback.createdAt,
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt
        : fallback.updatedAt,
  });
};

const applySuccessfulCommandState = (
  context: CommandExecutionContext,
  command: ScenarioParsedCommand,
  result: AutomationCommandExecutionResult,
) => {
  switch (command.name) {
    case "automations.identity.bind-actor": {
      const data = result.data && typeof result.data === "object" ? result.data : {};
      upsertIdentityBinding(
        context.state,
        {
          ...(data as Partial<AutomationSimulationIdentityBinding>),
          source: command.args.source,
          key: command.args.key,
          value: command.args.value,
          description:
            typeof command.args.description === "string"
              ? command.args.description
              : ((data as { description?: string | null }).description ?? null),
          status:
            typeof (data as { status?: unknown }).status === "string"
              ? String((data as { status?: unknown }).status)
              : "linked",
        },
        context.event.occurredAt,
      );
      break;
    }
    case "event.reply": {
      const replySource = command.args.source ?? context.event.source;
      const externalActorId =
        command.args.externalActorId ??
        (replySource === context.event.source ? context.event.actor?.externalId : undefined);
      if (!externalActorId) {
        break;
      }

      context.state.replies.push({
        eventId: context.event.id,
        source: replySource,
        externalActorId,
        text: command.args.text,
      });
      break;
    }
    case "otp.identity.create-claim": {
      context.state.claims.push(
        normalizeClaimFromData(context.state, context.event, command.args, result.data),
      );
      break;
    }
    case "pi.session.create": {
      upsertPiSession(
        context.state,
        normalizePiSessionFromData(context.state, context.event, command.args, result.data),
      );
      break;
    }
    case "event.emit": {
      const emitted =
        result.data && typeof result.data === "object"
          ? createDefaultEmittedEvent(context.state, context.event, command.args)
          : createDefaultEmittedEvent(context.state, context.event, command.args);
      if (result.data && typeof result.data === "object") {
        const data = result.data as Record<string, unknown>;
        context.state.emittedEvents.push({
          ...emitted,
          id: typeof data.eventId === "string" && data.eventId.trim() ? data.eventId : emitted.id,
          orgId: typeof data.orgId === "string" && data.orgId.trim() ? data.orgId : emitted.orgId,
          source:
            typeof data.source === "string" && data.source.trim() ? data.source : emitted.source,
          eventType:
            typeof data.eventType === "string" && data.eventType.trim()
              ? data.eventType
              : emitted.eventType,
        });
        break;
      }

      context.state.emittedEvents.push(emitted);
      break;
    }
  }
};

const executeBuiltinCommand = async (
  context: CommandExecutionContext,
  command: ScenarioParsedCommand,
): Promise<AutomationCommandExecutionResult> => {
  switch (command.name) {
    case "automations.identity.lookup-binding": {
      const binding = context.state.identityBindings.find(
        (entry) =>
          entry.source === command.args.source &&
          entry.key === command.args.key &&
          entry.status === "linked",
      );

      if (!binding) {
        return { exitCode: 1 };
      }

      return {
        data: clone(binding),
      };
    }
    case "automations.identity.bind-actor": {
      const binding = upsertIdentityBinding(
        context.state,
        {
          source: command.args.source,
          key: command.args.key,
          value: command.args.value,
          description: command.args.description ?? null,
          status: "linked",
        },
        context.event.occurredAt,
      );

      return {
        data: clone(binding),
      };
    }
    case "otp.identity.create-claim": {
      const claim = createDefaultClaim(context.state, context.event, command.args);
      context.state.claims.push(clone(claim));
      return {
        data: claim,
      };
    }
    case "event.reply": {
      const replySource = command.args.source ?? context.event.source;
      const activeExternalActorId =
        command.args.externalActorId ??
        (replySource === context.event.source ? context.event.actor?.externalId : undefined);

      if (typeof command.args.text !== "string" || command.args.text.length === 0) {
        throw new Error("event.reply requires a non-empty --text value");
      }

      if (!activeExternalActorId) {
        if (replySource !== context.event.source) {
          throw new Error(
            `event.reply requires --external-actor-id when replying through source '${replySource}' because the current event source is '${context.event.source}'`,
          );
        }

        throw new Error("Cannot call event.reply because no external actor id is available");
      }

      context.state.replies.push({
        eventId: context.event.id,
        source: replySource,
        externalActorId: activeExternalActorId,
        text: command.args.text,
      });

      return {
        data: {
          ok: true,
        },
      };
    }
    case "event.emit": {
      const emitted = createDefaultEmittedEvent(context.state, context.event, command.args);
      context.state.emittedEvents.push(clone(emitted));
      return {
        data: {
          accepted: true,
          eventId: emitted.id,
          orgId: emitted.orgId,
          source: emitted.source,
          eventType: emitted.eventType,
        },
      };
    }
    case "pi.session.create": {
      const session = createDefaultPiSession(context.state, context.event, command.args);
      upsertPiSession(context.state, session);
      return {
        data: clone(session),
      };
    }
    case "pi.session.get": {
      const session = context.state.piSessions.find((entry) => entry.id === command.args.sessionId);
      if (!session) {
        throw new Error(`Pi session '${command.args.sessionId}' was not found`);
      }

      return {
        data: clone(ensurePiSessionShape(session)),
      };
    }
    case "pi.session.list": {
      const sessions = context.state.piSessions.map((entry) => ensurePiSessionShape(entry));
      return {
        data:
          typeof command.args.limit === "number" ? sessions.slice(0, command.args.limit) : sessions,
      };
    }
  }
};

const projectDefaultSourceEnv = (event: AutomationEvent): Record<string, string | undefined> => {
  if (event.source === "telegram") {
    return {
      AUTOMATION_TELEGRAM_TEXT:
        typeof event.payload.text === "string" ? event.payload.text : undefined,
      AUTOMATION_TELEGRAM_CHAT_ID:
        typeof event.payload.chatId === "string" ? event.payload.chatId : undefined,
    };
  }

  return {};
};

const buildBashEnv = ({
  scenario,
  step,
  event,
  binding,
  sourceEnvProjectors,
}: {
  scenario: AutomationScenarioDefinition;
  step: AutomationScenarioStep;
  event: AutomationEvent;
  binding: AutomationBindingCatalogEntry;
  sourceEnvProjectors: Partial<Record<string, AutomationScenarioSourceEnvProjector>>;
}) => {
  const projectSourceEnv = sourceEnvProjectors[event.source] ?? projectDefaultSourceEnv;
  const triggerOrder = binding.triggerOrder;

  return Object.fromEntries(
    Object.entries({
      AUTOMATION_EVENT_ID: event.id,
      AUTOMATION_ORG_ID: event.orgId,
      AUTOMATION_SOURCE: event.source,
      AUTOMATION_EVENT_TYPE: event.eventType,
      AUTOMATION_OCCURRED_AT: event.occurredAt,
      AUTOMATION_ACTOR_TYPE: event.actor?.type,
      AUTOMATION_EXTERNAL_ACTOR_ID: event.actor?.externalId,
      AUTOMATION_SUBJECT_USER_ID: event.subject?.userId,
      AUTOMATION_BINDING_ID: binding.id,
      AUTOMATION_SCRIPT_ID: binding.scriptId,
      AUTOMATION_SCRIPT_KEY: binding.scriptKey,
      AUTOMATION_SCRIPT_NAME: binding.scriptName,
      AUTOMATION_SCRIPT_PATH: binding.scriptPath,
      AUTOMATION_SCRIPT_VERSION:
        binding.scriptVersion != null ? String(binding.scriptVersion) : undefined,
      AUTOMATION_SCRIPT_AGENT: binding.scriptAgent ?? undefined,
      AUTOMATION_TRIGGER_ORDER:
        triggerOrder != null && Number.isFinite(triggerOrder) ? String(triggerOrder) : undefined,
      ...binding.scriptEnv,
      ...projectSourceEnv(event),
      ...scenario.env,
      ...step.env,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
};

const createContextFiles = async (fs: InMemoryFs, event: AutomationEvent) => {
  await fs.mkdir("/context", { recursive: true });
  await Promise.all([
    fs.writeFile("/context/event.json", JSON.stringify(event)),
    fs.writeFile("/context/payload.json", JSON.stringify(event.payload ?? {})),
    fs.writeFile("/context/actor.json", JSON.stringify(event.actor ?? null)),
    fs.writeFile("/context/subject.json", JSON.stringify(event.subject ?? null)),
  ]);
};

const createScenarioCommands = ({
  context,
  commands,
}: {
  context: CommandExecutionContext;
  commands: AutomationSimulationCommandTranscript[];
}) => {
  return SUPPORTED_COMMAND_SPECS.map((spec) =>
    defineCommand(spec.name, async (args) => {
      const parsedTokens = parseCliTokens(args);
      const index = commands.length;

      if (hasHelpOption(parsedTokens)) {
        const stdout = buildCommandHelp(spec);
        commands.push({
          index,
          name: spec.name,
          rawArgs: [...args],
          args: null,
          output: null,
          stdout,
          stderr: "",
          exitCode: 0,
          resolution: { kind: "builtin" },
        });
        return {
          stdout,
          stderr: "",
          exitCode: 0,
        };
      }

      let command: ScenarioParsedCommand;
      try {
        command = spec.parse(args) as ScenarioParsedCommand;
      } catch (error) {
        const stderr = ensureTrailingNewline(
          error instanceof Error ? error.message : String(error),
        );
        commands.push({
          index,
          name: spec.name,
          rawArgs: [...args],
          args: null,
          output: null,
          stdout: "",
          stderr,
          exitCode: 1,
          resolution: { kind: "builtin" },
        });
        return {
          stdout: "",
          stderr,
          exitCode: 1,
        };
      }

      try {
        const { resolution, result: mockResult } = getCommandMock(context, spec.name);
        const rawResult = mockResult
          ? normalizeExecutionResult(mockResult)
          : await executeBuiltinCommand(context, command);
        const exitCode = typeof rawResult.exitCode === "number" ? rawResult.exitCode : 0;
        const stdout = formatCommandStdout(command.output, rawResult);
        const stderr = typeof rawResult.stderr === "string" ? rawResult.stderr : "";

        if (mockResult && exitCode === 0) {
          applySuccessfulCommandState(context, command, rawResult);
        }

        commands.push({
          index,
          name: spec.name,
          rawArgs: [...args],
          args: clone(command.args),
          output: clone(command.output),
          stdout,
          stderr,
          exitCode,
          resolution,
        });

        return {
          stdout,
          stderr,
          exitCode,
        };
      } catch (error) {
        const stderr = ensureTrailingNewline(
          error instanceof Error ? error.message : String(error),
        );
        commands.push({
          index,
          name: spec.name,
          rawArgs: [...args],
          args: clone(command.args),
          output: clone(command.output),
          stdout: "",
          stderr,
          exitCode: 1,
          resolution: { kind: "builtin" },
        });
        return {
          stdout: "",
          stderr,
          exitCode: 1,
        };
      }
    }),
  );
};

const executeBinding = async ({
  scenario,
  step,
  event,
  binding,
  state,
  commandMocks,
  mockCursorState,
  sourceEnvProjectors,
}: {
  scenario: AutomationScenarioDefinition;
  step: AutomationScenarioStep;
  event: AutomationEvent;
  binding: AutomationBindingCatalogEntry;
  state: AutomationSimulationState;
  commandMocks: AutomationScenarioDefinition["commandMocks"];
  mockCursorState: MockCursorState;
  sourceEnvProjectors: Partial<Record<string, AutomationScenarioSourceEnvProjector>>;
}): Promise<AutomationSimulationBindingTranscript> => {
  const fs = new InMemoryFs();
  await createContextFiles(fs, event);

  const commands: AutomationSimulationCommandTranscript[] = [];
  const bash = new Bash({
    fs,
    env: buildBashEnv({
      scenario,
      step,
      event,
      binding,
      sourceEnvProjectors,
    }),
    customCommands: createScenarioCommands({
      context: {
        event,
        binding,
        state,
        commandMocks,
        mockCursorState,
      },
      commands,
    }),
  });

  const result = await bash.exec(binding.scriptBody);

  return {
    index: 0,
    bindingId: binding.id,
    scriptId: binding.scriptId,
    scriptPath: binding.scriptPath,
    triggerOrder: binding.triggerOrder,
    status: (result.exitCode ?? 0) === 0 ? "completed" : "failed",
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    commands,
  };
};

export const defineAutomationScenario = <TScenario extends AutomationScenarioDefinition>(
  scenario: TScenario,
): TScenario => scenario;

export const loadAutomationScenarioFile = async (
  fileSystem: IFileSystem,
  path: string,
): Promise<AutomationScenarioDefinition> => {
  let content: string;
  try {
    content = await fileSystem.readFile(path, "utf-8");
  } catch (error) {
    throw new Error(
      `Automation scenario file '${path}' was not found: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Automation scenario file '${path}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseScenario(parsed);
};

export const simulateAutomationScenario = async ({
  fileSystem,
  scenario,
  sourceEnvProjectors = {},
}: SimulateAutomationScenarioOptions): Promise<AutomationSimulationResult> => {
  const parsedScenario = parseScenario(scenario);
  const catalog = await loadAutomationCatalog(fileSystem);
  const state = normalizeSimulationState(parsedScenario.initialState);
  const mockCursorState: MockCursorState = {};
  const transcriptSteps: AutomationSimulationStepTranscript[] = [];

  for (const [stepIndex, step] of parsedScenario.steps.entries()) {
    const event = clone(step.event);
    const matchingBindings = getAutomationBindingsForEvent(catalog, event);
    const bindingRuns: AutomationSimulationBindingTranscript[] = [];

    const stepTranscript: AutomationSimulationStepTranscript = {
      index: stepIndex,
      id: step.id ?? `step-${stepIndex + 1}`,
      title: step.title,
      event,
      matchedBindingIds: matchingBindings.map((binding) => binding.id),
      status: "completed",
      bindingRuns,
    };

    transcriptSteps.push(stepTranscript);

    for (const [bindingIndex, binding] of matchingBindings.entries()) {
      const bindingRun = await executeBinding({
        scenario: parsedScenario,
        step,
        event,
        binding,
        state,
        commandMocks: parsedScenario.commandMocks,
        mockCursorState,
        sourceEnvProjectors,
      });

      bindingRuns.push({
        ...bindingRun,
        index: bindingIndex,
      });

      if (bindingRun.exitCode !== 0) {
        stepTranscript.status = "failed";
        stepTranscript.failure = {
          bindingId: binding.id,
          scriptId: binding.scriptId,
          exitCode: bindingRun.exitCode,
          message: [
            `Automation bash script ${binding.scriptId} failed for event ${event.id} with exit code ${bindingRun.exitCode}.`,
            bindingRun.stderr.trim() || bindingRun.stdout.trim(),
          ]
            .filter(Boolean)
            .join(" "),
        };
        break;
      }
    }

    if (stepTranscript.status === "failed") {
      break;
    }
  }

  return {
    scenario: parsedScenario,
    transcript: {
      steps: transcriptSteps,
      totalBindingsRun: transcriptSteps.reduce((count, step) => count + step.bindingRuns.length, 0),
      totalCommandsRun: transcriptSteps.reduce(
        (count, step) =>
          count +
          step.bindingRuns.reduce(
            (bindingCount, binding) => bindingCount + binding.commands.length,
            0,
          ),
        0,
      ),
    },
    finalState: normalizeSimulationState(state),
  };
};

export const runAutomationScenarioFile = async ({
  fileSystem,
  path,
  sourceEnvProjectors,
}: RunAutomationScenarioFileOptions) => {
  const scenario = await loadAutomationScenarioFile(fileSystem, path);
  return simulateAutomationScenario({
    fileSystem,
    scenario,
    sourceEnvProjectors,
  });
};
