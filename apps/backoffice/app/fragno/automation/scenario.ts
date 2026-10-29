import {
  automationActorsSchema,
  type AutomationActors,
  type AutomationExternalEntityRef,
  type AutomationRouteDefinition,
  type AutomationRouteCreateInput,
  type AutomationRouteUpdateInput,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  type AutomationEvent,
  automationEventListResultSchema,
} from "@fragno-dev/backoffice-api/v0/events";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import type { BackofficePermissionRequirement } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import {
  type BackofficeContextScope,
  type BackofficeOrganizationContextScope,
  type BackofficeProjectOwner,
  type BackofficeScopeIdNames,
  backofficeScopeOrganization,
  backofficeScopePathSegment,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { WorkersAiBinding } from "@fragno-dev/cloudflare-fragment/workers-ai";
import { sanitizeToolName } from "@fragno-dev/codemode/runtime-api";
import { InMemoryFs, type IFileSystem } from "just-bash";

import type { ResendSendEmailInput } from "@fragno-dev/resend-fragment";
import type { TelegramApi, TelegramMessage } from "@fragno-dev/telegram-fragment";

import type { ClassifierContext, ClassifierResult, FetchFunction } from "@earendil-works/pi-ai";
import type { SubmissionRecord } from "@earendil-works/pi-durable";

import type { BackofficeRuntimeEnv } from "@/backoffice-runtime/backoffice-runtime-env";
import type { BackofficeTelemetrySignal } from "@/backoffice-runtime/backoffice-telemetry";
import {
  createBackofficeServiceExecution,
  createBackofficeSystemExecution,
  createBackofficeUserExecution,
  createBackofficeRequestExecution,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import {
  BackofficeKernel,
  type BackofficeKernelAction,
  type BackofficeKernelObserver,
} from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import type { LocalBackofficeDurableHooks } from "@/backoffice-runtime/node/local-runtime";
import type {
  BackofficeObjectAddress,
  BackofficeObjectBindingName,
} from "@/backoffice-runtime/object-registry";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";
import {
  createTelegramAutomationFileResponse,
  type TelegramAutomationFileMetadata,
} from "@/backoffice-runtime/telegram-file-response";
import { WORKSPACE_STARTER_CONTENT } from "@/files/content/starter";
import { STATIC_FILE_CONTENT } from "@/files/content/static";
import { SYSTEM_FILE_CONTENT } from "@/files/content/system";
import { issueBackofficeTokenResultSchema, type UserAuthorityFacts } from "@/fragno/auth/contracts";
import type { CodemodeRunToolCall } from "@/fragno/codemode/codemode-fragment";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { readSavedWorkflowProgram } from "@/fragno/codemode/workflow-program";
import {
  createScenarioReplicaDatabase,
  type ScenarioReplicaDatabase,
} from "@/fragno/lofi/scenario-replica-database";
import type { MarketplaceStaticEntry } from "@/fragno/marketplace/contracts";
import { marketplaceListingId } from "@/fragno/marketplace/owner";
import {
  MARKETPLACE_DECLARATION_PATH,
  parseMarketplacePackageDeclaration,
} from "@/fragno/marketplace/package-declaration";
import { isMarketplaceInternalPackagePath } from "@/fragno/marketplace/package-files";
import { getStaticMarketplaceEntry } from "@/fragno/marketplace/static-entries";
import { createBackofficeAgentContext } from "@/fragno/pi/agent/backoffice-agent-context";
import {
  piAgentObjectName,
  type PiAgent,
  type PiAgentPrompt,
  type PiAgentTurn,
  type PiAvailableModel,
} from "@/fragno/pi/agent/pi-agent-contract";
import {
  piNotificationInput,
  piNotificationRequestId,
  renderPiNotificationRequest,
} from "@/fragno/pi/agent/pi-agent-notification-entry";
import { piAgentTurnCompletedEvent } from "@/fragno/pi/agent/pi-agent-turn-events";
import {
  createPiClassifier,
  createPiExtractor,
  createPiImageGenerator,
  createPiWorkersAi,
  type PiClassifier,
} from "@/fragno/pi/agent/pi-models";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createStateShellFileSystem } from "@/fragno/runtime-tools/state-shell-file-system";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { uploadReplicaHost } from "@/fragno/upload/lofi/replica-host";
import { bytesToBase64 } from "@/lib/base64";
import type { CreateSandboxRuntimeProviders } from "@/sandbox/contracts";

import type { TelegramObject } from "../../../workers/telegram-object";
import { listHookScopes } from "../backoffice-capabilities/backoffice-capabilities";
import { AUTOMATION_SYSTEM_INITIATOR, BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY } from "./actors";
import { createRouteBackedAutomationStoreRuntime } from "./bindings-route-runtime";
import { createRouteBackedDurableHooksRuntime } from "./durable-hooks-route-runtime";
import {
  CODEMODE_WORKFLOW,
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "./engine/codemode-invocation";
import { automationReplicaHost } from "./lofi/replica-host";
import { createRouteBackedAutomationRouterRuntime } from "./routing-route-runtime";
import {
  getScenarioAuthMemberRoles,
  normalizeScenarioAuthRoles,
  removeScenarioAuthMember,
  setScenarioAuthMemberRoles,
  setScenarioAuthUserRole,
  setScenarioAuthUserStatus,
  setUpScenarioAuthMember,
  setUpScenarioAuthOrganization,
  setUpScenarioAuthUser,
  type ScenarioAuthMemberInput as AuthMemberInput,
  type ScenarioAuthMemberRolesInput as AuthMemberRolesInput,
  type ScenarioAuthOrganizationInput as AuthOrganizationInput,
  type ScenarioAuthUserInput as AuthUserInput,
  type ScenarioAuthUserRoleInput as AuthUserRoleInput,
  type ScenarioAuthUserStatusInput as AuthUserStatusInput,
} from "./scenario-auth";
import type { WorkflowReplyTo } from "./workflow-reply";
import { createRouteBackedAutomationWorkflowRuntime } from "./workflow-route-runtime";

type ScenarioVars = Record<string, unknown>;

type BackofficeScenarioStepKind = "given" | "when" | "then" | "runner";

export type BackofficeScenarioStep = {
  type: string;
  label: string;
  kind?: BackofficeScenarioStepKind;
  drain?: boolean;
  run(ctx: BackofficeScenarioContext): Promise<void> | void;
};

export type ScenarioJournalEntry = {
  phase: "setup" | "steps";
  label: string;
  type: string;
  status: "completed" | "failed";
};

export type ScenarioJournal = {
  entries: ScenarioJournalEntry[];
  current?: { phase: "setup" | "steps"; label: string; type: string };
};

export type BackofficeScenarioCodemodeInput = {
  scope: BackofficeContextScope;
  code: string;
  label?: string;
  timeout?: number;
  assertToolCalls?: readonly string[];
};

type ScenarioCodemodeRun = {
  label: string;
  scope: BackofficeContextScope;
  result: BackofficeCodemodeExecuteResult;
};

type TelegramSendCall = {
  method: "sendMessage";
  body: Record<string, unknown>;
};

type TelegramEditCall = {
  method: "editMessageText";
  body: Record<string, unknown>;
};

type TelegramChatActionCall = {
  method: "sendChatAction";
  body: Record<string, unknown>;
};

type TelegramGetFileCall = {
  fileId: string;
};

type TelegramDownloadFileCall = {
  fileId: string;
};

type FakeTelegramFile = TelegramAutomationFileMetadata & {
  bytes: Uint8Array;
  contentType?: string;
};

type FakePiAgent = {
  model: PiAgentTurn["agent"]["model"] | null;
  assistantText: string;
  answerEntryId: string | null;
  submissions: Map<string, SubmissionRecord>;
};

type PiProvisionedAgentCall = {
  agentName: string;
};

type PiGetViewCall = {
  agentName: string;
};

type PiTurnCall = {
  agentName: string;
  requestId: string;
  content: string;
  assistantText: string;
  answerEntryId: number;
  turn: PiAgentTurn;
};

type FakeResendThreadSeed = {
  id: string;
  subject?: string | null;
  participants?: string[];
  messages?: FakeResendMessageSeed[];
};

type FakeResendMessageSeed = {
  id: string;
  direction?: "inbound" | "outbound";
  from?: string | null;
  to?: string[];
  replyTo?: string[];
  subject?: string | null;
  text?: string | null;
  occurredAt?: string;
};

type FakeResendReplyCall = {
  threadId: string;
  body: Record<string, unknown>;
};

type FakeResendQueueEmailCall = {
  input: ResendSendEmailInput;
  options: { idempotencyKey: string; senderName: string | null };
};

type TelegramAdminApi = NonNullable<ConstructorParameters<typeof TelegramObject>[0]["adminApi"]>;

export type FakeTelegramApi = {
  api: TelegramApi;
  adminApi: TelegramAdminApi;
  sendMessageCalls: TelegramSendCall[];
  editMessageTextCalls: TelegramEditCall[];
  sendChatActionCalls: TelegramChatActionCall[];
  getFileCalls: TelegramGetFileCall[];
  downloadFileCalls: TelegramDownloadFileCall[];
  setWebhookCalls: Parameters<TelegramAdminApi["setWebhook"]>[0][];
  /** Telegram's webhook registration; a rejection makes the next registrations fail with it. */
  webhook: { registeredUrl: string | null; rejection: string | null };
  setFile(input: FakeTelegramFile): void;
  getFileFixture(fileId: string): FakeTelegramFile | null;
};

export type FakePiManagerApi = {
  provisionedAgents: PiProvisionedAgentCall[];
  getViewCalls: PiGetViewCall[];
  turns: PiTurnCall[];
  agent: PiAgent;
};

export type FakeResendApi = {
  replyCalls: FakeResendReplyCall[];
  queueEmailCalls: FakeResendQueueEmailCall[];
  queueEmail(
    input: ResendSendEmailInput,
    options: { idempotencyKey: string; senderName: string | null },
  ): Promise<void>;
  fetch(request: Request): Promise<Response>;
};

export type FakeClassifierApi = {
  /** Every classification requested, in order. */
  calls: ClassifierContext[];
  classify: PiClassifier;
};

export type FakeOpenAIModelApi = {
  /** Every request to the provider's HTTP API, in order. */
  requests: { url: string; body: unknown }[];
  fetch: FetchFunction;
};

/** One Cloudflare account's Workers AI: the binding that runs models and the API that describes them. */
export type FakeWorkersAi = {
  /** Every run, in order, with the model it named. */
  runs: { model: string; input: Record<string, unknown> }[];
  binding: WorkersAiBinding;
  /** Cloudflare's model documentation, which serves each model's schemas. */
  fetch: FetchFunction;
};

/** Websites the runtime downloads from, keyed by URL. */
type FakeWebApi = {
  /** Every request, in order, with the headers it carried. */
  requests: { url: string; headers: Record<string, string> }[];
  fetch: typeof fetch;
};

export type ScenarioFakes = {
  web?: FakeWebApi;
  telegram?: FakeTelegramApi;
  pi?: FakePiManagerApi;
  resend?: FakeResendApi;
  classifier?: FakeClassifierApi;
  openaiImages?: FakeOpenAIModelApi;
  openaiDecisions?: FakeOpenAIModelApi;
  openaiResponses?: FakeOpenAIModelApi;
  workersAi?: FakeWorkersAi;
};

type ScenarioFakeFactory = {
  /** Answers each URL with a fresh response from `responses`; any other URL answers 404. */
  web(input: { responses: Record<string, () => Response> }): FakeWebApi;
  telegram(input?: { files?: FakeTelegramFile[] }): FakeTelegramApi;
  pi(input?: {
    assistantText?: (input: { agentName: string; content: string }) => string;
  }): FakePiManagerApi;
  resend(input?: { threads?: FakeResendThreadSeed[] }): FakeResendApi;
  /** Answers every classification with `answer`, reporting `inputTokens` of usage. */
  classifier(input: {
    answer: (context: ClassifierContext) => ClassifierResult["answers"];
    inputTokens: number;
  }): FakeClassifierApi;
  /** Answers every Images API generation with `image` in the requested format and this usage. */
  openaiImages(input: {
    image: Uint8Array;
    inputTokens: number;
    outputTokens: number;
  }): FakeOpenAIModelApi;
  /** Serves Decisions answers over HTTP so scenarios exercise the real Pi adapter. */
  openaiDecisions(input: {
    answers: ClassifierResult["answers"];
    inputTokens: number;
  }): FakeOpenAIModelApi;
  /** Answers every Responses API request with `output` as its structured answer and this usage. */
  openaiResponses(input: {
    output: unknown;
    inputTokens: number;
    outputTokens: number;
  }): FakeOpenAIModelApi;
  /**
   * An account that runs these models, publishing their schemas. Each run answers with `output`
   * and bills `neurons`; null leaves the usage header out. Other models do not exist.
   */
  workersAi(input: {
    models: Record<
      string,
      {
        schemas: { input: Record<string, unknown>; output: Record<string, unknown> };
        run: (input: Record<string, unknown>) => { output: unknown; neurons: number | null };
      }
    >;
  }): FakeWorkersAi;
};

type FileDiffStatus = "added" | "changed" | "removed";

type FileDiffEntry = {
  path: string;
  status: FileDiffStatus;
  before?: string;
  after?: string;
};

type BackofficeScenarioFilePreset = {
  createFileSystem(): IFileSystem;
  snapshot: Record<string, string>;
};

export type BackofficeScenarioFileSystems = {
  forOrg(orgId?: string): IFileSystem;
  forProject(projectId: string): IFileSystem;
  forUser(userId: string): IFileSystem;
  listOrgIds(): string[];
  rememberOrgPaths(orgId: string, paths: readonly string[]): void;
  diff(
    orgId?: string,
    readAdditionalPath?: (path: string) => Promise<string | null>,
  ): Promise<FileDiffEntry[]>;
};

/** SQLite replicas of the scopes' outboxes, as browsers open them. */
export type BackofficeScenarioLofi = {
  automations: ScenarioReplicaDatabase;
  upload: ScenarioReplicaDatabase;
  syncAll(): Promise<void>;
  cleanup(): Promise<void>;
};

export type BackofficeScenarioContext<TVars extends ScenarioVars = ScenarioVars> = {
  name: string;
  runtime: InMemoryBackofficeRuntime;
  files: BackofficeScenarioFileSystems;
  vars: TVars;
  fakes: ScenarioFakes;
  lofi: BackofficeScenarioLofi;
  codemodeRuns: ScenarioCodemodeRun[];
  kernelActions: readonly BackofficeKernelAction[];
  /** Every signal the scenario's objects reported, in order. */
  telemetry: readonly BackofficeTelemetrySignal[];
  journal: ScenarioJournal;
  drain(): Promise<void>;
  runCodemode(input: BackofficeScenarioCodemodeInput): Promise<BackofficeCodemodeExecuteResult>;
  cleanup(): Promise<void>;
  rememberOrg(orgId: string): void;
};

export type BackofficeScenarioDefinitionInput<TVars extends ScenarioVars = ScenarioVars> = {
  name: string;
  env?: Partial<BackofficeRuntimeEnv>;
  files?: BackofficeScenarioFilePreset;
  vars?: () => TVars;
  fakes?: (ctx: { fake: ScenarioFakeFactory }) => ScenarioFakes;
  /**
   * The objects this scenario's runtime registers; only these are loaded. Fakes provide their own
   * object (`fake.telegram()` provides TELEGRAM, for example), whether or not this lists it.
   */
  objects: LocalBackofficeObjects;
  piAvailableModels?: readonly PiAvailableModel[];
  createSandboxProviders?: CreateSandboxRuntimeProviders;
  durableHooks?: LocalBackofficeDurableHooks;
  setup?: (builders: BackofficeScenarioStepBuilders<TVars>) => BackofficeScenarioStep[];
  steps: (builders: BackofficeScenarioStepBuilders<TVars>) => BackofficeScenarioStep[];
  options?: {
    drain?: boolean;
    allowErroredWorkflows?: boolean;
    allowFailedDurableHooks?: boolean;
    sqliteDataDirectory?: string;
  };
};

export type BackofficeScenarioDefinition<TVars extends ScenarioVars = ScenarioVars> =
  BackofficeScenarioDefinitionInput<TVars>;

type AuthAuthorityAssertionInput = {
  userId: string;
  orgId?: string;
  /** Whether the user is active, their role, and whether they act in the organization asked about. */
  expected: Pick<UserAuthorityFacts, "active" | "role"> & { organizationMember: boolean };
};

type AuthMemberAssertionInput = {
  orgId: string;
  userId: string;
  roles: readonly string[];
};

type AuthPermissionsAssertionInput = {
  userId: string;
  scope: BackofficeContextScope;
  include?: readonly BackofficePermissionRequirement[];
  exclude?: readonly BackofficePermissionRequirement[];
};

type OrganizationExistsInput = {
  id: string;
  slug?: string;
  name?: string;
  ownerUserId?: string;
  ownerRoles?: readonly string[];
};

type TelegramConfiguredInput = {
  orgId: string;
  botUsername: string;
  botToken?: string;
  webhookSecretToken?: string;
  apiBaseUrl?: string;
};

type TelegramMessageInput = {
  orgId: string;
  updateId: string | number;
  messageId?: string | number;
  chatId: string;
  text: string;
  from?: {
    id?: string | number;
    firstName?: string;
    username?: string;
  };
};

type TelegramWebhookInput = {
  orgId: string;
  update: unknown;
  label?: string;
};

type TelegramSentMessageInput = {
  chatId?: string;
  text: string | RegExp;
  captureUrlAs?: string;
};

type TelegramSentChatActionInput = {
  chatId?: string;
  action: string;
};

type PiProvisionedAgentInput = {
  agentName?: string;
};

type PiRanPromptInput = {
  agentName?: string;
  content?: string;
  assistantText?: string | RegExp;
};

/** The tracker is read from the ledger of the scope's root owner. */
type BillingTrackerAssertionInput = {
  scope: BackofficeContextScope;
  period: string;
  meter: string;
  quantity: string;
  eventCount?: string;
};

type ResendRepliedToThreadInput = {
  threadId?: string;
  body?: string | RegExp;
};

type ResendQueuedEmailInput = {
  to?: string;
  subject?: string;
  text?: string | RegExp;
  idempotencyKey?: string | RegExp;
};

type StoreEntryInput = {
  orgId: string;
  key: string;
  value: string;
};

type IdentityBindingInput = {
  orgId: string;
  externalId: string;
  userId: string;
  source?: string;
  externalType?: string;
  verifiedByClaimId?: string;
};

type IdentityRevokeInput = {
  orgId: string;
  externalId: string;
  expectedUserId: string;
  expectedVersion?: number;
  source?: string;
  externalType?: string;
};

type StoreEntriesInput = {
  orgId: string;
  prefix?: string;
  include: Array<string | { key: string; value?: string }>;
};

type ProjectCreateInput = {
  owner: BackofficeProjectOwner<BackofficeScopeIdNames>;
  slug?: string;
  name: string;
  description?: string | null;
  createdByUserId: string;
  captureIdAs?: string;
  label?: string;
};

type CodemodeStoreSetInput = StoreEntryInput;

type CodemodeWriteFileInput = FileAssertionInput & {
  content: string | Uint8Array;
};

type FilesSetupInput = {
  orgId: string;
  files: Record<string, string | Uint8Array>;
};

type CodemodeToolCallsInput = {
  include: readonly string[];
  label?: string;
};

type AutomationEventAssertionInput = {
  scope: BackofficeContextScope;
  where: {
    id?: string;
    source?: string;
    eventType?: string;
  };
  expected: DeepPartial<Omit<AutomationEvent, "actors">> & {
    actors?: AutomationActors;
  };
};

type IdentityAssertionInput = {
  scope: BackofficeContextScope;
  identity: AutomationExternalEntityRef;
};

type IdentityResolvesInput = IdentityAssertionInput & {
  userId: string;
};

type KernelActionAssertionInput = {
  operation: BackofficePermissionRequirement;
  scope: BackofficeContextScope;
  actors?: DeepPartial<AutomationActors>;
  resource?: unknown;
};

type WorkflowInstanceInput = {
  workflowName?: string;
  instanceId?: string;
  remoteWorkflowName?: string;
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  waitingFor?: string;
  params?: unknown;
  output?: unknown;
  actors?: DeepPartial<AutomationActors>;
};

type WorkflowStepsInput = {
  workflowName?: string;
  instanceId?: string;
  remoteWorkflowName?: string;
  include: readonly string[];
};

type WorkflowEventInput = {
  workflowName?: string;
  instanceId?: string;
  remoteWorkflowName?: string;
  type?: string;
  payload?: unknown;
  consumedByStepKey?: string | null;
};

type ScenarioValue<TVars extends ScenarioVars, TValue> =
  | TValue
  | ((ctx: BackofficeScenarioContext<TVars>) => Promise<TValue> | TValue);

type AuthSignUpInput = {
  email: string;
  password?: string;
  /** Leaves the user to onboard, which the scenario then does; others start onboarded. */
  onboarding?: "pending";
  captureSessionCookieAs?: string;
  // Session cookies are origin-bound: plain-HTTP origins get insecure cookie names.
  origin?: string;
};
type AuthCreateOrganizationInput<TVars extends ScenarioVars> = {
  cookie: ScenarioValue<TVars, string>;
  name: string;
  slug: string;
  captureOrganizationIdAs?: string;
};
type AuthOrganizationSessionInput<TVars extends ScenarioVars> = {
  cookie: ScenarioValue<TVars, string>;
  organizationId: ScenarioValue<TVars, string>;
};
type AuthInviteMemberInput<TVars extends ScenarioVars> = AuthOrganizationSessionInput<TVars> & {
  email: string;
  role?: "member" | "admin" | "owner";
  captureInvitationIdAs?: string;
};
type AuthAcceptInvitationInput<TVars extends ScenarioVars> = {
  cookie: ScenarioValue<TVars, string>;
  invitationId: ScenarioValue<TVars, string>;
};
type AuthSessionInput<TVars extends ScenarioVars> = {
  cookie: ScenarioValue<TVars, string>;
};
type AuthMemberRemoveInput<TVars extends ScenarioVars> = {
  orgId: ScenarioValue<TVars, string>;
  userId: ScenarioValue<TVars, string>;
};
type WorkflowCreateInstanceInput<TVars extends ScenarioVars = ScenarioVars> = {
  orgId: string;
  workflowName?: string;
  remoteWorkflowName?: string;
  instanceId: string;
  execution?: ScenarioValue<TVars, BackofficeExecutionContext>;
  label?: string;
} & (
  | {
      path: string;
      event: ScenarioValue<TVars, AutomationEvent>;
      /** Where the run reports when it ends, such as the agent that started it; null by default. */
      replyTo?: WorkflowReplyTo;
      params?: never;
    }
  | {
      path?: never;
      event?: never;
      replyTo?: never;
      params: ScenarioValue<TVars, Record<string, unknown>>;
    }
);

type WorkflowSendEventInput<TVars extends ScenarioVars = ScenarioVars> = {
  orgId: string;
  workflowName?: string;
  instanceId: string;
  type: string;
  payload: ScenarioValue<TVars, unknown>;
  label?: string;
};

type HooksNoPendingInput = {
  orgId?: string;
  fragments?: readonly string[];
};

type ConfirmClaimFromCapturedUrlInput = {
  url: string;
  subjectUserId: string;
};

type ConfirmClaimInput = {
  orgId: string;
  otpId: string;
  subjectUserId: string;
  claimType?: string;
  eventId?: string;
  actor?: {
    source?: string;
    type?: string;
    id: string;
  };
};

type OrganizationCreatedInput = {
  id: string;
  name: string;
  slug?: string;
  ownerUserId?: string;
  ownerEmail?: string;
  eventId?: string;
};

type CapabilityConfiguredInput = {
  orgId: string;
  source?: string;
  capabilityId: string;
  capabilityLabel?: string;
  payload?: Record<string, unknown>;
  eventId?: string;
};

type FileAssertionInput = {
  orgId: string;
  path: string;
};

type FileContainsInput = FileAssertionInput & {
  text: string | RegExp;
};

type FileJsonEqualsInput = FileAssertionInput & {
  value: unknown;
};

type FileDiffInput = {
  orgId: string;
  include?: readonly (string | { path: string; status?: FileDiffStatus })[];
};

type TimeAdvanceInput = string | number;

type RouterCreateRouteInput = AutomationRouteCreateInput & { orgId: string; label?: string };

type RouterUpdateRouteInput = AutomationRouteUpdateInput & { orgId: string; label?: string };

type RouterSeedStarterInput = { orgId: string };

/** Scenario installs coordinate in the organization that owns the target. */
type MarketplaceInstallTargetScope =
  | BackofficeOrganizationContextScope
  | { kind: "project"; owner: BackofficeOrganizationContextScope; projectId: string };

/** Installs approve the permissions the release declares and finish without settings input. */
type MarketplaceInstallInput = {
  targetScope: MarketplaceInstallTargetScope;
  slug: string;
  version: string;
  /** The workspace folder the package installs into, such as `/workspace`. */
  installationRoot: string;
};

type DeepPartial<T> = T extends readonly (infer TItem)[]
  ? readonly DeepPartial<TItem>[]
  : T extends object
    ? { [TKey in keyof T]?: DeepPartial<T[TKey]> }
    : T;

type RouterRouteAssertionInput = {
  orgId: string;
  id: string;
} & DeepPartial<AutomationRouteDefinition>;

type RouterRoutesAssertionInput = {
  orgId: string;
  include?: readonly (string | ({ id: string } & DeepPartial<AutomationRouteDefinition>))[];
  exclude?: readonly string[];
  count?: number;
};

export type BackofficeScenarioStepBuilders<TVars extends ScenarioVars = ScenarioVars> = {
  given: {
    auth: {
      user(input: AuthUserInput): BackofficeScenarioStep;
      organization(input: AuthOrganizationInput): BackofficeScenarioStep;
      member(input: AuthMemberInput): BackofficeScenarioStep;
    };
    organization: {
      exists(input: OrganizationExistsInput): BackofficeScenarioStep;
    };
    marketplace: {
      entries(entries: readonly MarketplaceStaticEntry[]): BackofficeScenarioStep;
    };
    telegram: {
      configured(input: TelegramConfiguredInput): BackofficeScenarioStep;
    };
    store: {
      entry(input: StoreEntryInput): BackofficeScenarioStep;
    };
    identity: {
      binding(input: IdentityBindingInput): BackofficeScenarioStep;
    };
    router: {
      route(input: RouterCreateRouteInput): BackofficeScenarioStep;
    };
    files(input: FilesSetupInput): BackofficeScenarioStep;
    codemode: {
      run(input: BackofficeScenarioCodemodeInput): BackofficeScenarioStep;
      storeSet(input: CodemodeStoreSetInput): BackofficeScenarioStep;
      writeFile(input: CodemodeWriteFileInput): BackofficeScenarioStep;
    };
    direct: {
      storeEntry(input: StoreEntryInput): BackofficeScenarioStep;
      file(input: FileAssertionInput & { content: string | Uint8Array }): BackofficeScenarioStep;
    };
  };
  when: {
    auth: {
      signUp(input: AuthSignUpInput): BackofficeScenarioStep;
      createOrganization(input: AuthCreateOrganizationInput<TVars>): BackofficeScenarioStep;
      inviteMember(input: AuthInviteMemberInput<TVars>): BackofficeScenarioStep;
      acceptInvitation(input: AuthAcceptInvitationInput<TVars>): BackofficeScenarioStep;
      signOut(input: AuthSessionInput<TVars>): BackofficeScenarioStep;
      organizationCreated(input: OrganizationCreatedInput): BackofficeScenarioStep;
      setUserRole(input: AuthUserRoleInput): BackofficeScenarioStep;
      setUserStatus(input: AuthUserStatusInput): BackofficeScenarioStep;
      setMemberRoles(input: AuthMemberRolesInput): BackofficeScenarioStep;
      removeMember(input: AuthMemberRemoveInput<TVars>): BackofficeScenarioStep;
    };
    capability: {
      configured(input: CapabilityConfiguredInput): BackofficeScenarioStep;
    };
    marketplace: {
      install(input: MarketplaceInstallInput): BackofficeScenarioStep;
    };
    automation: {
      ingestEvent(input: AutomationEvent): BackofficeScenarioStep;
    };
    identity: {
      revoke(input: IdentityRevokeInput): BackofficeScenarioStep;
    };
    router: {
      seedStarter(input: RouterSeedStarterInput): BackofficeScenarioStep;
      createRoute(input: RouterCreateRouteInput): BackofficeScenarioStep;
      updateRoute(input: RouterUpdateRouteInput): BackofficeScenarioStep;
    };
    project: {
      create(input: ProjectCreateInput): BackofficeScenarioStep;
    };
    codemode: {
      run(input: BackofficeScenarioCodemodeInput): BackofficeScenarioStep;
    };
    telegram: {
      webhook(input: TelegramWebhookInput): BackofficeScenarioStep;
      receivesMessage(input: TelegramMessageInput): BackofficeScenarioStep;
    };
    workflow: {
      createInstance(input: WorkflowCreateInstanceInput<TVars>): BackofficeScenarioStep;
      sendEvent(input: WorkflowSendEventInput<TVars>): BackofficeScenarioStep;
    };
    otp: {
      confirmClaim(input: ConfirmClaimInput): BackofficeScenarioStep;
      confirmClaimFromCapturedUrl(input: ConfirmClaimFromCapturedUrlInput): BackofficeScenarioStep;
    };
    time: {
      advance(duration: TimeAdvanceInput): BackofficeScenarioStep;
    };
  };
  // oxlint-disable-next-line no-thenable -- `then` is the requested assertion namespace.
  then: {
    auth: {
      authority(input: AuthAuthorityAssertionInput): BackofficeScenarioStep;
      member(input: AuthMemberAssertionInput): BackofficeScenarioStep;
      permissions(input: AuthPermissionsAssertionInput): BackofficeScenarioStep;
      sessionWithoutOrganization(input: AuthSessionInput<TVars>): BackofficeScenarioStep;
      sessionHasOrganization(input: AuthOrganizationSessionInput<TVars>): BackofficeScenarioStep;
      signedOut(input: AuthSessionInput<TVars>): BackofficeScenarioStep;
    };
    automation: {
      event(input: AutomationEventAssertionInput): BackofficeScenarioStep;
    };
    identity: {
      resolves(input: IdentityResolvesInput): BackofficeScenarioStep;
      unresolved(input: IdentityAssertionInput): BackofficeScenarioStep;
    };
    kernel: {
      action(input: KernelActionAssertionInput): BackofficeScenarioStep;
    };
    telegram: {
      sentMessage(input: TelegramSentMessageInput): BackofficeScenarioStep;
      noMessages(): BackofficeScenarioStep;
      sentChatAction(input: TelegramSentChatActionInput): BackofficeScenarioStep;
    };
    pi: {
      provisionedAgent(input: PiProvisionedAgentInput): BackofficeScenarioStep;
      ranPrompt(input: PiRanPromptInput): BackofficeScenarioStep;
    };
    billing: {
      tracker(input: BillingTrackerAssertionInput): BackofficeScenarioStep;
    };
    resend: {
      queuedEmail(input: ResendQueuedEmailInput): BackofficeScenarioStep;
      noQueuedEmails(): BackofficeScenarioStep;
      repliedToThread(input: ResendRepliedToThreadInput): BackofficeScenarioStep;
    };
    store: {
      entry(input: StoreEntryInput): BackofficeScenarioStep;
      missing(input: Omit<StoreEntryInput, "value">): BackofficeScenarioStep;
      entries(input: StoreEntriesInput): BackofficeScenarioStep;
    };
    router: {
      route(input: RouterRouteAssertionInput): BackofficeScenarioStep;
      missing(input: { orgId: string; id: string }): BackofficeScenarioStep;
      routes(input: RouterRoutesAssertionInput): BackofficeScenarioStep;
    };
    workflow: {
      instance(input: WorkflowInstanceInput): BackofficeScenarioStep;
      missing(
        input: Pick<WorkflowInstanceInput, "workflowName" | "instanceId" | "remoteWorkflowName">,
      ): BackofficeScenarioStep;
      steps(input: WorkflowStepsInput): BackofficeScenarioStep;
      event(input: WorkflowEventInput): BackofficeScenarioStep;
      noErrored(input?: { orgId?: string }): BackofficeScenarioStep;
    };
    hooks: {
      noPending(input?: HooksNoPendingInput): BackofficeScenarioStep;
      noFailed(input?: HooksNoPendingInput): BackofficeScenarioStep;
    };
    codemode: {
      toolCalls(input: CodemodeToolCallsInput): BackofficeScenarioStep;
    };
    files: {
      exists(input: FileAssertionInput): BackofficeScenarioStep;
      missing(input: FileAssertionInput): BackofficeScenarioStep;
      contains(input: FileContainsInput): BackofficeScenarioStep;
      bytes(input: FileAssertionInput & { content: Uint8Array }): BackofficeScenarioStep;
      jsonEquals(input: FileJsonEqualsInput): BackofficeScenarioStep;
      diff(input: FileDiffInput): BackofficeScenarioStep;
    };
    assert(
      label: string,
      assertion: (ctx: BackofficeScenarioContext<TVars>) => Promise<void> | void,
    ): BackofficeScenarioStep;
  };
  runner: {
    drain(): BackofficeScenarioStep;
    restartObject(address: BackofficeObjectAddress): BackofficeScenarioStep;
    /** Deletes the object's alarm behind its back, as Cloudflare drops an alarm that kept failing. */
    dropObjectAlarm(address: BackofficeObjectAddress): BackofficeScenarioStep;
  };
};

const mapContentToMountedFiles = (
  mountPoint: "/static" | "/system" | "/workspace",
  files: Record<string, string | Uint8Array>,
) =>
  Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      `${mountPoint}/${path.replace(/^\/+/u, "")}`,
      content,
    ]),
  );

const createPreset = (
  files: Record<string, string | Uint8Array>,
): BackofficeScenarioFilePreset => ({
  createFileSystem: () => new InMemoryFs(files),
  snapshot: Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      typeof content === "string" ? content : `[binary:${content.byteLength}]`,
    ]),
  ),
});

/** The permissions a bundled release declares, which installing it must approve. */
export function bundledMarketplacePermissions({
  slug,
  version,
}: {
  slug: string;
  version: string;
}) {
  const entry = getStaticMarketplaceEntry({ slug, version });
  if (!entry) {
    throw new Error(`Scenario could not find bundled Marketplace entry '${slug}@${version}'.`);
  }
  const declaration = entry.files[MARKETPLACE_DECLARATION_PATH];
  return declaration ? parseMarketplacePackageDeclaration(declaration).permissions : [];
}

export const backofficeFiles = {
  systemOnly: () =>
    createPreset({
      ...mapContentToMountedFiles("/static", STATIC_FILE_CONTENT),
      ...mapContentToMountedFiles("/system", SYSTEM_FILE_CONTENT),
    }),
  workspaceStarter: (additionalFiles: Record<string, string | Uint8Array> = {}) =>
    createPreset(
      mapContentToMountedFiles("/workspace", {
        ...WORKSPACE_STARTER_CONTENT,
        ...additionalFiles,
      }),
    ),
  fullStarter: () =>
    createPreset({
      ...mapContentToMountedFiles("/static", STATIC_FILE_CONTENT),
      ...mapContentToMountedFiles("/system", SYSTEM_FILE_CONTENT),
      ...mapContentToMountedFiles("/workspace", WORKSPACE_STARTER_CONTENT),
    }),
  custom: (input: {
    system?: Record<string, string | Uint8Array>;
    workspace?: Record<string, string | Uint8Array>;
  }) =>
    createPreset({
      ...mapContentToMountedFiles("/system", input.system ?? {}),
      ...mapContentToMountedFiles("/workspace", input.workspace ?? {}),
    }),
};

export const defineBackofficeScenario = <TVars extends ScenarioVars = ScenarioVars>(
  scenario: BackofficeScenarioDefinitionInput<TVars>,
): BackofficeScenarioDefinition<TVars> => scenario;

const createFakeTelegramApi = (input: { files?: FakeTelegramFile[] } = {}): FakeTelegramApi => {
  const sendMessageCalls: TelegramSendCall[] = [];
  const editMessageTextCalls: TelegramEditCall[] = [];
  const sendChatActionCalls: TelegramChatActionCall[] = [];
  const getFileCalls: TelegramGetFileCall[] = [];
  const downloadFileCalls: TelegramDownloadFileCall[] = [];
  const setWebhookCalls: Parameters<TelegramAdminApi["setWebhook"]>[0][] = [];
  const webhook: FakeTelegramApi["webhook"] = { registeredUrl: null, rejection: null };
  const filesById = new Map<string, FakeTelegramFile>();

  const setFile = (file: FakeTelegramFile) => {
    filesById.set(file.fileId, file);
  };

  for (const file of input.files ?? []) {
    setFile(file);
  }

  const buildMessage = (payload: Record<string, unknown>): TelegramMessage => ({
    messageId: sendMessageCalls.length + editMessageTextCalls.length,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(payload.chat_id),
      type: "private",
    },
    text: String(payload.text ?? ""),
  });

  const normalizePayload = (payload: Record<string, unknown>) => ({
    ...payload,
    chat_id: payload.chat_id ?? payload.chatId,
  });

  return {
    sendMessageCalls,
    editMessageTextCalls,
    sendChatActionCalls,
    getFileCalls,
    downloadFileCalls,
    setWebhookCalls,
    webhook,
    setFile,
    getFileFixture: (fileId) => filesById.get(fileId) ?? null,
    adminApi: {
      setWebhook: async (input) => {
        setWebhookCalls.push(input);
        if (webhook.rejection !== null) {
          return { ok: false, message: webhook.rejection };
        }
        webhook.registeredUrl = input.webhookUrl;
        return { ok: true, message: "webhook set" };
      },
      getWebhookInfo: async () => ({
        ok: true,
        url: webhook.registeredUrl ?? "",
        lastErrorMessage: null,
      }),
    },
    api: {
      call: async () => ({ ok: false, description: "Unsupported fake Telegram API call" }),
      sendMessage: async (payload) => {
        const body = normalizePayload(payload);
        sendMessageCalls.push({ method: "sendMessage", body });
        return { ok: true, result: buildMessage(body) };
      },
      editMessageText: async (payload) => {
        const body = normalizePayload(payload);
        editMessageTextCalls.push({ method: "editMessageText", body });
        return { ok: true, result: buildMessage(body) };
      },
      sendChatAction: async (payload) => {
        const body = normalizePayload(payload);
        sendChatActionCalls.push({ method: "sendChatAction", body });
        return { ok: true, result: true };
      },
    },
  };
};

const createFakePiManagerApi = (
  options: {
    assistantText?: (input: { agentName: string; content: string }) => string;
  } = {},
): FakePiManagerApi => {
  const provisionedAgents: PiProvisionedAgentCall[] = [];
  const getViewCalls: PiGetViewCall[] = [];
  const turns: PiTurnCall[] = [];
  const agents = new Map<string, FakePiAgent>();
  const assistantText =
    options.assistantText ?? ((input: { content: string }) => `agent:${input.content}`);

  function requireAgent(config: PiAgentConfig) {
    const key = piAgentObjectName(config);
    const existing = agents.get(key);
    if (existing) {
      return existing;
    }
    const agent: FakePiAgent = {
      model: null,
      assistantText: "",
      answerEntryId: null,
      submissions: new Map(),
    };
    agents.set(key, agent);
    provisionedAgents.push({
      agentName: config.agentName,
    });
    return agent;
  }

  function conversationView(agent: FakePiAgent) {
    const timestamp = Date.parse("2026-01-01T00:00:00.000Z");
    return {
      conversation: { id: 1 },
      entries: agent.answerEntryId
        ? [
            {
              id: agent.answerEntryId,
              conversationId: 1,
              kind: "assistant",
              model: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: agent.assistantText }],
                  api: "openai-responses",
                  provider: agent.model?.provider,
                  model: agent.model?.modelId,
                  usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                  stopReason: "stop",
                  timestamp,
                },
              ],
            },
          ]
        : [],
      docs: {},
    };
  }

  // The fake answers each prompt as it receives it, steered or dispatched.
  const answer = async (config: PiAgentConfig, turn: PiAgentTurn, prompt: PiAgentPrompt) => {
    const fake = requireAgent(config);
    if (fake.submissions.has(prompt.requestId)) {
      return;
    }
    const reply = assistantText({ agentName: config.agentName, content: prompt.content });
    const submissionId = turns.length + 1;
    const answerEntryId = `answer-${submissionId}`;
    // Like Pi, the conversation keeps its model for turns that name none.
    fake.model = turn.agent.model ?? fake.model;
    fake.assistantText = reply;
    fake.answerEntryId = answerEntryId;
    fake.submissions.set(prompt.requestId, {
      id: submissionId,
      conversationId: 1,
      requestId: prompt.requestId,
      type: "input",
      status: "done",
      entry: `input-${submissionId}`,
      answer: answerEntryId,
    } as unknown as SubmissionRecord);
    turns.push({
      agentName: config.agentName,
      requestId: prompt.requestId,
      content: prompt.content,
      assistantText: reply,
      answerEntryId: submissionId,
      turn,
    });
  };

  const agent: PiAgent = {
    async warm() {},
    // The fake does not stop, so no stop fences the revisions work is handed over at.
    async steer(config, _revision, turn, steer) {
      await answer(
        config,
        turn,
        steer.type === "prompt" ? steer : piNotificationInput(steer.notification),
      );
    },
    async dispatch(config, _revision, turn, work) {
      await answer(config, turn, {
        requestId: work.requestId,
        content:
          work.type === "prompt"
            ? work.content
            : renderPiNotificationRequest(
                work.notifications.map(({ routeId, event }) => ({ routeId, eventId: event.id })),
              ),
      });
    },
    async writeNotifications(config) {
      requireAgent(config);
    },
    async startSubagent(config, _revision, turn, prompt) {
      await answer(config, turn, prompt);
    },
    async recordSubagent(config) {
      requireAgent(config);
    },
    async getView(config) {
      const fake = requireAgent(config);
      getViewCalls.push({ agentName: config.agentName });
      return conversationView(fake);
    },
    async fetch() {
      throw new Error("The fake Pi agent serves no view sockets.");
    },
    // The fake has no viewers to show its queue to.
    async publishQueue() {},
    async getSubmission(config, requestId) {
      return requireAgent(config).submissions.get(requestId) ?? null;
    },
    async getSubagentRuns(config, requestIds) {
      const fake = requireAgent(config);
      return requestIds.map((requestId) => ({
        requestId,
        submission: fake.submissions.get(requestId) ?? null,
        startedAt: null,
        answeredAt: null,
        answer: null,
      }));
    },
    async listEntries(config) {
      requireAgent(config);
      // The fake never compacts, so no history precedes its active context.
      return { entries: [], cursor: null };
    },
    async listMessages(config, { last, before }) {
      requireAgent(config);
      // Only the answers, which turn.completed names: like Pi, an answer that said nothing is no
      // message.
      const said = turns.filter(
        (turn) =>
          turn.agentName === config.agentName &&
          turn.assistantText !== "" &&
          (before === null || turn.answerEntryId < before),
      );
      const messages = said.slice(-last).map((turn) => ({
        entryId: turn.answerEntryId,
        role: "assistant" as const,
        text: turn.assistantText,
        sentAt: "2026-01-01T00:00:00.000Z",
      }));
      return {
        messages,
        before: said.length > messages.length ? (messages[0]?.entryId ?? null) : null,
      };
    },
    async exportEntries(config) {
      const fake = requireAgent(config);
      const bytes = new TextEncoder().encode(
        `${JSON.stringify({ type: "pi-durable-agent", version: 2, order: "oldest-first" })}\n${conversationView(
          fake,
        )
          .entries.map((entry) => JSON.stringify({ type: "entry", entry }))
          .join("\n")}\n`,
      );
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    async compact() {
      return { taskId: 1 };
    },
    async getCompaction(_config, taskId) {
      return { taskId, status: "completed", message: null };
    },
    async reset() {},
    async abort() {},
  };

  return { provisionedAgents, getViewCalls, turns, agent };
};

const RESEND_FAKE_TIMESTAMP = "2026-03-18T12:00:00.000Z";

const normalizeSubject = (subject: string | null) => subject?.toLowerCase() ?? "";

const createFakeResendMessage = (
  thread: { id: string; subject: string | null; participants: string[] },
  input: FakeResendMessageSeed,
) => {
  const subject = input.subject ?? thread.subject;
  const occurredAt = input.occurredAt ?? RESEND_FAKE_TIMESTAMP;

  return {
    id: input.id,
    threadId: thread.id,
    direction: input.direction ?? "inbound",
    status: "sent",
    from: input.from ?? thread.participants[0] ?? null,
    to: input.to ?? thread.participants.slice(1),
    cc: [],
    bcc: [],
    replyTo: input.replyTo ?? [],
    subject,
    normalizedSubject: normalizeSubject(subject),
    participants: thread.participants,
    messageId: null,
    inReplyTo: null,
    references: [],
    providerEmailId: `provider-${input.id}`,
    attachments: [],
    html: null,
    text: input.text ?? "",
    headers: null,
    occurredAt,
    scheduledAt: null,
    sentAt: occurredAt,
    lastEventType: null,
    lastEventAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
};

const createFakeResendThread = (input: FakeResendThreadSeed) => {
  const subject = input.subject ?? "Scenario Resend Thread";
  const participants = input.participants ?? ["customer@example.com", "support@example.com"];
  const thread = {
    id: input.id,
    subject,
    participants,
  };
  const messages = (
    input.messages?.length
      ? input.messages
      : [
          {
            id: `${input.id}-message-1`,
            subject,
            text: "Hello from the scenario Resend thread.",
          },
        ]
  ).map((message) => createFakeResendMessage(thread, message));
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1] ?? firstMessage;
  const lastText = lastMessage?.text ?? "";

  return {
    detail: {
      id: input.id,
      subject,
      normalizedSubject: normalizeSubject(subject),
      participants,
      messageCount: messages.length,
      firstMessageAt: firstMessage?.occurredAt ?? RESEND_FAKE_TIMESTAMP,
      lastMessageAt: lastMessage?.occurredAt ?? RESEND_FAKE_TIMESTAMP,
      lastDirection: lastMessage?.direction ?? null,
      lastMessagePreview: lastText ? lastText.slice(0, 120) : null,
      replyToAddress: "support@example.com",
      createdAt: firstMessage?.createdAt ?? RESEND_FAKE_TIMESTAMP,
      updatedAt: lastMessage?.updatedAt ?? RESEND_FAKE_TIMESTAMP,
    },
    messages,
  };
};

const createFakeResendApi = (input: { threads?: FakeResendThreadSeed[] } = {}): FakeResendApi => {
  const replyCalls: FakeResendReplyCall[] = [];
  const queueEmailCalls: FakeResendQueueEmailCall[] = [];
  const threads = new Map(
    (input.threads?.length ? input.threads : [{ id: "thread-1" }]).map((thread) => {
      const normalized = createFakeResendThread(thread);
      return [normalized.detail.id, normalized] as const;
    }),
  );

  const getThreadOrResponse = (threadId: string) => {
    const thread = threads.get(threadId);
    if (!thread) {
      return Response.json({ message: "Not found.", code: "THREAD_NOT_FOUND" }, { status: 404 });
    }
    return thread;
  };

  return {
    replyCalls,
    queueEmailCalls,
    queueEmail: async (emailInput, options) => {
      queueEmailCalls.push({ input: emailInput, options });
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const threadMatch = /\/api\/resend\/threads\/([^/]+)(?:\/([^/]+))?$/u.exec(pathname);
      const threadId = threadMatch ? decodeURIComponent(threadMatch[1] ?? "") : "";
      const suffix = threadMatch?.[2] ?? "";

      if (request.method === "GET" && pathname === "/api/resend/threads") {
        return Response.json({
          threads: Array.from(threads.values()).map(({ detail }) => {
            const { replyToAddress: _replyToAddress, ...summary } = detail;
            return summary;
          }),
          hasNextPage: false,
        });
      }

      if (!threadId) {
        return Response.json({ message: "Not found.", code: "NOT_FOUND" }, { status: 404 });
      }

      const thread = getThreadOrResponse(threadId);
      if (thread instanceof Response) {
        return thread;
      }

      if (request.method === "GET" && !suffix) {
        return Response.json(thread.detail);
      }

      if (request.method === "GET" && suffix === "messages") {
        return Response.json({
          messages: thread.messages,
          hasNextPage: false,
        });
      }

      if (request.method === "POST" && suffix === "reply") {
        const body = (await request.json()) as Record<string, unknown>;
        replyCalls.push({ threadId, body });
        const message = createFakeResendMessage(
          {
            id: thread.detail.id,
            subject: thread.detail.subject,
            participants: thread.detail.participants,
          },
          {
            id: `${threadId}-reply-${replyCalls.length}`,
            direction: "outbound",
            from: thread.detail.replyToAddress,
            to: Array.isArray(body.to) ? body.to.map(String) : [],
            subject: typeof body.subject === "string" ? body.subject : thread.detail.subject,
            text: typeof body.text === "string" ? body.text : "",
          },
        );
        thread.messages.unshift(message);
        thread.detail.messageCount = thread.messages.length;
        thread.detail.lastDirection = message.direction;
        thread.detail.lastMessagePreview = message.text ? message.text.slice(0, 120) : null;
        thread.detail.lastMessageAt = message.occurredAt;
        thread.detail.updatedAt = message.updatedAt;
        return Response.json({ thread: thread.detail, message });
      }

      return Response.json({ message: "Not found.", code: "NOT_FOUND" }, { status: 404 });
    },
  };
};

// OpenAI's Decisions price for gpt-6-luna input tokens.
const FAKE_CLASSIFIER_USD_PER_INPUT_TOKEN = 0.1 / 1_000_000;

const createFakeClassifierApi: ScenarioFakeFactory["classifier"] = ({ answer, inputTokens }) => {
  const calls: ClassifierContext[] = [];
  const cost = inputTokens * FAKE_CLASSIFIER_USD_PER_INPUT_TOKEN;
  return {
    calls,
    classify: async (context) => {
      calls.push(context);
      return {
        api: "openai-decisions",
        provider: "openai",
        model: "gpt-6-luna",
        answers: answer(context),
        usage: {
          input: inputTokens,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: inputTokens,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  };
};

const createFakeOpenAIImagesApi: ScenarioFakeFactory["openaiImages"] = ({
  image,
  inputTokens,
  outputTokens,
}) => {
  const requests: FakeOpenAIModelApi["requests"] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as { output_format: string };
      requests.push({ url: request.url, body });
      return Response.json({
        created: 1_792_486_800,
        data: [{ b64_json: bytesToBase64(image) }],
        output_format: body.output_format,
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { text_tokens: inputTokens, image_tokens: 0 },
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      });
    },
  };
};

function createFakeOpenAIDecisionsApi({
  answers,
  inputTokens,
}: Parameters<ScenarioFakeFactory["openaiDecisions"]>[0]): FakeOpenAIModelApi {
  const requests: FakeOpenAIModelApi["requests"] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json() });
      return Response.json({
        answers: Object.entries(answers).map(([name, answer]) => {
          if (answer.type === "bool") {
            return { name, type: "predicate", probability: answer.probability };
          }
          if (answer.type === "choice") {
            return {
              ...answer,
              name,
              probabilities: Object.entries(answer.probabilities).map(([value, probability]) => ({
                value,
                probability,
              })),
            };
          }
          return { ...answer, name };
        }),
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      });
    },
  };
}

function createFakeOpenAIResponsesApi({
  output,
  inputTokens,
  outputTokens,
}: Parameters<ScenarioFakeFactory["openaiResponses"]>[0]): FakeOpenAIModelApi {
  const requests: FakeOpenAIModelApi["requests"] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json() });
      return Response.json({
        id: `resp_${requests.length}`,
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(output), annotations: [] }],
          },
        ],
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: inputTokens + outputTokens,
        },
      });
    },
  };
}

function createFakeWorkersAi({
  models,
}: Parameters<ScenarioFakeFactory["workersAi"]>[0]): FakeWorkersAi {
  const runs: FakeWorkersAi["runs"] = [];
  return {
    runs,
    binding: {
      async run(model, input) {
        runs.push({ model, input });
        const known = models[model];
        if (!known) {
          const description = `No such model ${model} or task`;
          return Response.json(
            { name: "AiError", internalCode: 5007, httpCode: 400, description },
            { status: 400 },
          );
        }
        const { output, neurons } = known.run(input);
        return Response.json(output, {
          headers: neurons === null ? {} : { "cf-ai-neurons": neurons.toFixed(2) },
        });
      },
    },
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      const [, name, direction] =
        /^\/workers-ai\/models\/([^/]+)\/schema-(input|output)\.json$/u.exec(path) ?? [];
      const known = Object.entries(models).find(([model]) => model.split("/").at(-1) === name);
      return known && (direction === "input" || direction === "output")
        ? Response.json(known[1].schemas[direction])
        : new Response("Not Found", { status: 404 });
    },
  };
}

function createFakeWebApi({ responses }: Parameters<ScenarioFakeFactory["web"]>[0]): FakeWebApi {
  const requests: FakeWebApi["requests"] = [];
  return {
    requests,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      return responses[request.url]?.() ?? new Response("Not Found", { status: 404 });
    },
  };
}

const createScenarioFakeFactory = (): ScenarioFakeFactory => ({
  telegram: createFakeTelegramApi,
  pi: createFakePiManagerApi,
  resend: createFakeResendApi,
  classifier: createFakeClassifierApi,
  openaiImages: createFakeOpenAIImagesApi,
  openaiDecisions: createFakeOpenAIDecisionsApi,
  openaiResponses: createFakeOpenAIResponsesApi,
  workersAi: createFakeWorkersAi,
  web: createFakeWebApi,
});

const readSnapshotContent = async (fs: IFileSystem, path: string): Promise<string | null> => {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile) {
      return null;
    }
    return await fs.readFile(path, "utf-8");
  } catch {
    try {
      const bytes = await fs.readFileBuffer(path);
      return `[binary:${bytes.byteLength}]`;
    } catch {
      return null;
    }
  }
};

const snapshotFileSystem = async (
  fs: IFileSystem,
  additionalPaths: readonly string[] = [],
): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};

  const visitDirectory = async (directory: string): Promise<void> => {
    const names = await fs.readdir(directory);
    await Promise.all(
      names.map(async (name) => {
        const path = fs.resolvePath(directory, name);
        const entry = await fs.stat(path);
        if (entry.isDirectory) {
          await visitDirectory(path);
          return;
        }
        if (!entry.isFile) {
          return;
        }

        const content = await readSnapshotContent(fs, path);
        if (content !== null) {
          snapshot[path] = content;
        }
      }),
    );
  };

  await visitDirectory("/");
  for (const path of additionalPaths) {
    if (path in snapshot) {
      continue;
    }
    const content = await readSnapshotContent(fs, path);
    if (content !== null) {
      snapshot[path] = content;
    }
  }
  return snapshot;
};

const diffSnapshots = (
  before: Record<string, string>,
  after: Record<string, string>,
): FileDiffEntry[] => {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: FileDiffEntry[] = [];

  for (const path of Array.from(paths).sort((left, right) => left.localeCompare(right))) {
    const beforeContent = before[path];
    const afterContent = after[path];
    if (typeof beforeContent === "undefined" && typeof afterContent !== "undefined") {
      diff.push({ path, status: "added", after: afterContent });
      continue;
    }
    if (typeof beforeContent !== "undefined" && typeof afterContent === "undefined") {
      diff.push({ path, status: "removed", before: beforeContent });
      continue;
    }
    if (beforeContent !== afterContent) {
      diff.push({ path, status: "changed", before: beforeContent, after: afterContent });
    }
  }

  return diff;
};

const createScenarioFileSystems = (
  preset: BackofficeScenarioFilePreset,
  orgIds: Set<string>,
): BackofficeScenarioFileSystems => {
  const byOrg = new Map<string, IFileSystem>();
  const byProject = new Map<string, IFileSystem>();
  const byUser = new Map<string, IFileSystem>();
  const rememberedOrgPaths = new Map<string, Set<string>>();

  const getScopedFs = (map: Map<string, IFileSystem>, key: string) => {
    let fs = map.get(key);
    if (!fs) {
      fs = preset.createFileSystem();
      map.set(key, fs);
    }
    return fs;
  };

  const forOrg = (orgId = "__default__") => {
    orgIds.add(orgId);
    return getScopedFs(byOrg, orgId);
  };

  return {
    forOrg,
    forProject: (projectId) => getScopedFs(byProject, projectId),
    forUser: (userId) => getScopedFs(byUser, userId),
    listOrgIds: () => Array.from(orgIds),
    rememberOrgPaths: (orgId, paths) => {
      const rememberedPaths = rememberedOrgPaths.get(orgId) ?? new Set<string>();
      paths.forEach((path) => {
        rememberedPaths.add(path);
      });
      rememberedOrgPaths.set(orgId, rememberedPaths);
    },
    diff: async (orgId = "__default__", readAdditionalPath) => {
      const [after, additionalFiles] = await Promise.all([
        snapshotFileSystem(forOrg(orgId)),
        Promise.all(
          Array.from(rememberedOrgPaths.get(orgId) ?? [], async (path) => ({
            path,
            content: readAdditionalPath
              ? await readAdditionalPath(path)
              : await readSnapshotContent(forOrg(orgId), path),
          })),
        ),
      ]);
      for (const { path, content } of additionalFiles) {
        if (content !== null) {
          after[path] = content;
        }
      }
      return diffSnapshots(preset.snapshot, after);
    },
  };
};

const createStep = (
  kind: BackofficeScenarioStepKind,
  type: string,
  label: string,
  run: BackofficeScenarioStep["run"],
  options: { drain?: boolean } = {},
): BackofficeScenarioStep => ({
  kind,
  type,
  label,
  drain: options.drain ?? kind === "when",
  run,
});

const getStore = (ctx: BackofficeScenarioContext, orgId: string) => {
  const scope = { kind: "org" as const, orgId, jurisdiction: null };
  return createRouteBackedAutomationStoreRuntime({
    object: ctx.runtime.objects.automations.for({ kind: "org", orgId: orgId, jurisdiction: null }),
    execution: {
      kind: "deferred",
      scopeRestriction: null,
      scope,
      actors: { initiator: AUTOMATION_SYSTEM_INITIATOR, principal: null, delegation: [] },
    },
  });
};

const SYSTEM_WORKFLOW_TARGET_ID = "__system__";

const getWorkflow = (
  ctx: BackofficeScenarioContext,
  orgId: string,
  execution?: BackofficeExecutionContext,
) => {
  const scope =
    orgId === SYSTEM_WORKFLOW_TARGET_ID
      ? ({ kind: "system" } as const)
      : ({ kind: "org", orgId, jurisdiction: null } as const);
  return createRouteBackedAutomationWorkflowRuntime({
    object:
      scope.kind === "system"
        ? ctx.runtime.objects.automations.singleton()
        : ctx.runtime.objects.automations.for({
            kind: "org",
            orgId: scope.orgId,
            jurisdiction: null,
          }),
    execution:
      execution ??
      (scope.kind === "system"
        ? createBackofficeSystemExecution(scope)
        : createBackofficeServiceExecution({
            scope,
            service: { type: "automation", id: "scenario" },
          })),
  });
};

const getRouter = (ctx: BackofficeScenarioContext, orgId: string) => {
  const scope = { kind: "org" as const, orgId, jurisdiction: null };
  return createRouteBackedAutomationRouterRuntime({
    object: ctx.runtime.objects.automations.for({ kind: "org", orgId: orgId, jurisdiction: null }),
    execution: createBackofficeSystemExecution(scope),
  });
};

const getHooks = (ctx: BackofficeScenarioContext, orgId: string) =>
  createRouteBackedDurableHooksRuntime({
    objects: ctx.runtime.objects,
    config: ctx.runtime.config,
    organization: { kind: "org", orgId, jurisdiction: null },
  });

const automationScopedBaseUrl = (scope: BackofficeContextScope) =>
  `http://scenario.local/api/automations-scoped/${backofficeContextScopeRoutePath(scope)}`;

const internalRouteSuffix = (requestUrl: URL) => {
  const internalPathIndex = requestUrl.pathname.indexOf("/_internal");
  return internalPathIndex >= 0
    ? requestUrl.pathname.slice(internalPathIndex)
    : requestUrl.pathname;
};

const createScenarioAutomationFetch = (
  runtime: InMemoryBackofficeRuntime,
  scope: BackofficeContextScope,
): typeof fetch => {
  return async (input, init) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    const forwardedUrl = new URL(
      `http://scenario.local/api/automations${internalRouteSuffix(requestUrl)}`,
    );
    forwardedUrl.search = requestUrl.search;

    const kernel = new BackofficeKernel(runtime.services);
    const automations = kernel.scoped("AUTOMATIONS", scope, runtime.objects.automations);
    return await automations.http.fetch(new Request(forwardedUrl.toString(), request));
  };
};

const uploadScopedBaseUrl = (scope: BackofficeContextScope) =>
  `http://scenario.local/api/upload-scoped/${backofficeContextScopeRoutePath(scope)}`;

/** Forwards like `routes/api/upload-scoped.ts`, without its authentication. */
const createScenarioUploadFetch = (
  runtime: InMemoryBackofficeRuntime,
  scope: BackofficeContextScope,
): typeof fetch => {
  return async (input, init) => {
    const request = new Request(input, init);
    const requestUrl = new URL(request.url);
    const forwardedUrl = new URL(
      `http://scenario.local/api/upload${internalRouteSuffix(requestUrl)}`,
    );
    forwardedUrl.search = requestUrl.search;

    const kernel = new BackofficeKernel(runtime.services);
    const upload = kernel.scoped("UPLOAD", scope, runtime.objects.upload);
    return await upload.http.fetch(new Request(forwardedUrl.toString(), request));
  };
};

const createScenarioLofi = (runtime: InMemoryBackofficeRuntime): BackofficeScenarioLofi => {
  const automations = createScenarioReplicaDatabase({
    name: "Automations replica",
    ...automationReplicaHost,
    drainRuntime: () => runtime.drain(),
    baseUrl: automationScopedBaseUrl,
    createFetch: (scope) => createScenarioAutomationFetch(runtime, scope),
  });
  const upload = createScenarioReplicaDatabase({
    name: "Upload replica",
    ...uploadReplicaHost,
    drainRuntime: () => runtime.drain(),
    baseUrl: uploadScopedBaseUrl,
    createFetch: (scope) => createScenarioUploadFetch(runtime, scope),
  });
  return {
    automations,
    upload,
    syncAll: async () => {
      await Promise.all([automations.syncAll(), upload.syncAll()]);
    },
    cleanup: async () => {
      await Promise.all([automations.cleanup(), upload.cleanup()]);
    },
  };
};

const hookFragmentBindings: Record<string, BackofficeObjectBindingName> = {
  api: "API",
  auth: "AUTH",
  automations: "AUTOMATIONS",
  codemode: "CODEMODE",
  github: "GITHUB",
  mcp: "MCP",
  otp: "OTP",
  pi: "AUTOMATIONS",
  workflows: "AUTOMATIONS",
  resend: "RESEND",
  telegram: "TELEGRAM",
  upload: "UPLOAD",
};

const hookFragmentObjectAddress = (
  fragment: string,
  orgId: string,
): BackofficeObjectAddress | null => {
  const binding = hookFragmentBindings[fragment];
  if (!binding) {
    return null;
  }

  if (binding === "AUTH") {
    return { binding, scope: { kind: "singleton" } };
  }

  return { binding, scope: { kind: "org", orgId, jurisdiction: null } };
};

const listInstantiatedHookFragments = (ctx: BackofficeScenarioContext, orgIds: string[]) =>
  listHookScopes()
    .filter((scope) =>
      orgIds.some((orgId) => {
        const address = hookFragmentObjectAddress(scope.id, orgId);
        return address ? ctx.runtime.hasObjectInstance(address) : true;
      }),
    )
    .map((scope) => scope.id);

const fileExists = async (fs: IFileSystem, path: string): Promise<boolean> => {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
};

const getReadableScenarioFileSystem = async (
  ctx: BackofficeScenarioContext,
  orgId: string,
  path: string,
): Promise<IFileSystem | null> => {
  const scenarioFs = ctx.files.forOrg(orgId);
  if (await fileExists(scenarioFs, path)) {
    return scenarioFs;
  }

  const execution = createBackofficeSystemExecution({ kind: "org", orgId, jurisdiction: null });
  const orgFs = createStateShellFileSystem(
    createRuntimeStateBackend({
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel(ctx.runtime.services),
      execution,
    }),
  );
  if (await fileExists(orgFs, path)) {
    return orgFs;
  }

  return null;
};

/**
 * Names a call as its guest wrote it (`store.set`), with the scope kind its handle named
 * (`org:store.set`), or by its tool's operation ID (`admin.oauth-clients.create`).
 */
const matchesToolCall = (call: CodemodeRunToolCall, expected: string) => {
  const name = `${call.provider}.${call.tool}`;
  if (expected === name || expected === `${call.scope.kind}:${name}`) {
    return true;
  }
  return runtimeToolFamilies.some((family) =>
    family.tools.some(
      (tool) =>
        tool.id === expected &&
        tool.namespace === call.provider &&
        (tool.name === call.tool || sanitizeToolName(tool.name) === call.tool),
    ),
  );
};

const parseScenarioDurationMs = (duration: TimeAdvanceInput): number => {
  if (typeof duration === "number") {
    return duration;
  }

  const trimmed = duration.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(\w+)?$/iu.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  switch (unit) {
    case "ms":
    case "millisecond":
    case "milliseconds":
      return value;
    case "s":
    case "sec":
    case "secs":
    case "second":
    case "seconds":
      return value * 1000;
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return value * 60 * 1000;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return value * 60 * 60 * 1000;
    case "d":
    case "day":
    case "days":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
};

const isUnavailableHookRepositoryError = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes(" is unavailable") || message.includes("Not configured");
};

const assertCodemodeToolCalls = (
  result: BackofficeCodemodeExecuteResult,
  expectedCalls: readonly string[],
) => {
  const missing = expectedCalls.filter(
    (expected) => !result.toolCalls.some((call) => matchesToolCall(call, expected)),
  );

  if (missing.length > 0) {
    throw new Error(
      `Expected codemode tool calls ${missing.join(", ")}. Calls: ${JSON.stringify(
        result.toolCalls,
        null,
        2,
      )}`,
    );
  }
};

const runScenarioCodemode = async (
  ctx: BackofficeScenarioContext,
  input: BackofficeScenarioCodemodeInput,
) => {
  const organization = backofficeScopeOrganization(input.scope);
  if (organization) {
    ctx.rememberOrg(organization.orgId);
  }

  const kernel = new BackofficeKernel(ctx.runtime.services);
  const execution = createBackofficeSystemExecution(input.scope);
  const runtimeContext = createCodemodeRouteBackedRuntimeContext({
    emitter: { kind: "caller" },
    runtime: ctx.runtime.services,
    kernel,
    execution,
  });
  const toolContext = createBackofficeToolContext(runtimeContext);
  const result = await runBackofficeCodemode({
    code: input.code,
    codemode: codemodeRunnerFor(ctx.runtime.objects.codemode.for(input.scope).commands, execution),
    timeout: input.timeout,
    families: runtimeToolFamilies,
    toolContext: toolContext,
  });

  ctx.codemodeRuns.push({
    label: input.label ?? "run codemode",
    scope: input.scope,
    result,
  });

  if (result.error) {
    throw new Error(`Codemode failed: ${result.error}`);
  }

  if (input.assertToolCalls) {
    assertCodemodeToolCalls(result, input.assertToolCalls);
  }

  return result;
};

const isSystemRoutedAutomationEvent = (event: AutomationEvent) =>
  event.source === "automations" && event.eventType === "project.created";

const orgIdForAutomationEvent = (event: AutomationEvent) =>
  event.scope.kind === "org"
    ? event.scope.orgId
    : event.subject?.scope?.kind === "org"
      ? event.subject.scope.orgId
      : undefined;

const ingestSystemAutomationEvent = async (
  ctx: BackofficeScenarioContext,
  event: AutomationEvent,
) => {
  const orgId = orgIdForAutomationEvent(event);
  if (orgId) {
    ctx.rememberOrg(orgId);
  }

  const systemAutomations = ctx.runtime.objects.automations.singleton();
  await systemAutomations.commands.seedStarterAutomationRoutes();
  await systemAutomations.commands.ingestEvent({ ...event, scope: { kind: "system" } });
};

const ingestAutomationEvent = async (ctx: BackofficeScenarioContext, event: AutomationEvent) => {
  if (event.scope.kind === "system" || event.source === "auth") {
    await ingestSystemAutomationEvent(ctx, event);
    return;
  }

  if (event.scope.kind !== "org") {
    throw new Error("Automation scenario events require an organization scope.");
  }

  ctx.rememberOrg(event.scope.orgId);
  if (isSystemRoutedAutomationEvent(event)) {
    const systemAutomations = ctx.runtime.objects.automations.singleton();
    await systemAutomations.commands.seedStarterAutomationRoutes();
    await systemAutomations.commands.ingestEvent({ ...event, id: `system:${event.id}` });
  }
  await ctx.runtime.objects.automations
    .for({ kind: "org", orgId: event.scope.orgId, jurisdiction: null })
    .commands.ingestEvent(event);
};

const buildOrganizationCreatedEvent = (input: OrganizationCreatedInput): AutomationEvent => {
  const now = "2026-01-01T00:00:00.000Z";
  const ownerUserId = input.ownerUserId ?? "user-1";

  return {
    id: input.eventId ?? `auth:organization.created:${input.id}`,
    scopeRestriction: null,
    scope: { kind: "org", orgId: input.id, jurisdiction: null },
    source: "auth",
    eventType: "organization.created",
    occurredAt: now,
    payload: {
      organization: {
        id: input.id,
        name: input.name,
        slug: input.slug ?? input.id,
        logoUrl: null,
        metadata: null,
        createdBy: ownerUserId,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    },
    actors: {
      initiator: {
        scope: "internal",
        type: "user",
        id: ownerUserId,
        role: "initiator",
      },
      principal: null,
      delegation: [],
    },
    subject: { scope: { kind: "org", orgId: input.id, jurisdiction: null } },
    causation: { kind: "origin" },
  };
};

const buildCapabilityConfiguredEvent = (input: CapabilityConfiguredInput): AutomationEvent => ({
  id: input.eventId ?? `${input.source ?? input.capabilityId}:capability.configured:${input.orgId}`,
  scopeRestriction: null,
  scope: { kind: "org", orgId: input.orgId, jurisdiction: null },
  source: input.source ?? input.capabilityId,
  eventType: "capability.configured",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {
    capabilityId: input.capabilityId,
    capabilityLabel: input.capabilityLabel ?? input.capabilityId,
    ...input.payload,
  },
  actors: {
    initiator: AUTOMATION_SYSTEM_INITIATOR,
    principal: null,
    delegation: [],
  },
  subject: {
    scope: { kind: "org", orgId: input.orgId, jurisdiction: null },
    capabilityId: input.capabilityId,
  },
  causation: { kind: "origin" },
});

const buildIdentityClaimCompletedEvent = (input: ConfirmClaimInput): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: input.actor?.source ?? "telegram",
    type: input.actor?.type ?? "chat",
    id: input.actor?.id ?? "unknown",
    role: "initiator" as const,
  };

  return {
    id: input.eventId ?? `identity-claim-completed:${input.otpId}`,
    scopeRestriction: null,
    scope: { kind: "org", orgId: input.orgId, jurisdiction: null },
    source: "otp",
    eventType: "identity.claim.completed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      otpId: input.otpId,
      claimType: input.claimType ?? "identity_link",
    },
    actors: {
      initiator: actor,
      principal: null,
      delegation: [],
    },
    subject: {
      userId: input.subjectUserId,
    },
    causation: { kind: "origin" },
  };
};

const asTelegramUpdateId = (value: string | number): number => {
  if (typeof value === "number") {
    return value;
  }

  const parsed = Number(value);
  if (Number.isSafeInteger(parsed)) {
    return parsed;
  }

  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_000;
  }
  return hash;
};

const buildTelegramMessageUpdate = (input: TelegramMessageInput) => {
  const messageId = asTelegramUpdateId(input.messageId ?? input.updateId);
  const fromId = asTelegramUpdateId(input.from?.id ?? input.chatId);

  return {
    update_id: asTelegramUpdateId(input.updateId),
    message: {
      message_id: messageId,
      date: 1_780_000_000,
      text: input.text,
      from: {
        id: fromId,
        is_bot: false,
        first_name: input.from?.firstName ?? "Scenario",
        username: input.from?.username,
      },
      chat: {
        id: Number(input.chatId),
        type: "private",
        first_name: input.from?.firstName ?? "Scenario",
        username: input.from?.username,
      },
    },
  };
};

const postTelegramWebhook = async (
  ctx: BackofficeScenarioContext,
  orgId: string,
  update: unknown,
) => {
  ctx.rememberOrg(orgId);
  const secret = String(
    ctx.vars[`telegram:${orgId}:webhookSecretToken`] ?? "telegram-webhook-secret",
  );
  const response = await ctx.runtime.objects.telegram
    .for({ kind: "org", orgId: orgId, jurisdiction: null })
    .http.fetch(
      new Request("https://telegram.do/api/telegram/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        body: JSON.stringify(update),
      }),
    );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Telegram webhook returned ${response.status}: ${JSON.stringify(body)}`);
  }
};

const extractFirstUrl = (text: string): string => {
  const match = /https?:\/\/\S+/u.exec(text);
  if (!match) {
    throw new Error(`Expected text to contain a URL: ${text}`);
  }
  return match[0];
};

const textMatches = (actual: string, expected: string | RegExp): boolean =>
  typeof expected === "string" ? actual === expected : expected.test(actual);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const assertPartialMatch = (actual: unknown, expected: unknown, path = "value") => {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      throw new Error(`Expected ${path} to be an array, got ${JSON.stringify(actual)}.`);
    }
    if (actual.length !== expected.length) {
      throw new Error(`Expected ${path} to have ${expected.length} items, got ${actual.length}.`);
    }
    expected.forEach((expectedValue, index) => {
      assertPartialMatch(actual[index], expectedValue, `${path}[${index}]`);
    });
    return;
  }

  if (!isRecord(expected)) {
    if (actual !== expected) {
      throw new Error(
        `Expected ${path} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
      );
    }
    return;
  }

  if (!isRecord(actual)) {
    throw new Error(`Expected ${path} to be an object, got ${JSON.stringify(actual)}.`);
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    assertPartialMatch(actual[key], expectedValue, `${path}.${key}`);
  }
};

const resolveScenarioValue = async <TVars extends ScenarioVars, TValue>(
  ctx: BackofficeScenarioContext,
  value: ScenarioValue<TVars, TValue>,
): Promise<TValue> =>
  typeof value === "function"
    ? await (value as (ctx: BackofficeScenarioContext) => Promise<TValue> | TValue)(ctx)
    : value;

const scenarioAuthRequest = (
  ctx: BackofficeScenarioContext,
  path: string,
  input: { cookie?: string; body?: unknown } = {},
  origin = "https://backoffice.example",
) =>
  ctx.runtime.objects.auth.singleton().http.fetch(
    new Request(`${origin}/api/auth${path}`, {
      method: input.body === undefined ? "GET" : "POST",
      headers: {
        origin,
        ...(input.cookie ? { cookie: input.cookie } : {}),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    }),
  );

const scenarioAuthCookie = (response: Response): string => {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    return "";
  }
  return setCookie
    .split(/,(?=\s*[^;,=]+=[^;,]+)/u)
    .map((header) => header.trim().split(";", 1)[0])
    .join("; ");
};

const scenarioIdString = (id: unknown): string =>
  typeof id === "object" && id && "externalId" in id ? String(id.externalId) : String(id);

const permissionKey = (permission: BackofficePermissionRequirement) =>
  `${permission.namespace}:${permission.permission}`;

type ScenarioWorkflowInstance = {
  orgId: string;
  workflowName: string;
  instance: {
    id: string;
    details: {
      status: string;
      output?: unknown;
      error?: unknown;
    };
    meta: Record<string, unknown>;
  };
};

const findWorkflowInstances = async (
  ctx: BackofficeScenarioContext,
  input: {
    workflowName?: string;
    instanceId?: string;
    remoteWorkflowName?: string;
  },
): Promise<ScenarioWorkflowInstance[]> => {
  const orgIds = [SYSTEM_WORKFLOW_TARGET_ID, ...ctx.files.listOrgIds()];
  const workflowName = input.workflowName ?? "codemode-script";
  const matches: ScenarioWorkflowInstance[] = [];

  for (const orgId of orgIds) {
    const workflow = getWorkflow(ctx, orgId);
    if (input.instanceId && workflow.getInternalInstance) {
      try {
        const instance = await workflow.getInternalInstance({
          workflowName,
          instanceId: input.instanceId,
        });
        matches.push({ orgId, workflowName, instance });
      } catch {
        // Keep looking across known orgs.
      }
      continue;
    }

    const response = await workflow.listInternalInstances?.({
      workflowName,
      remoteWorkflowName: input.remoteWorkflowName,
      pageSize: 100,
    });
    for (const summary of response?.instances ?? []) {
      const instance = workflow.getInternalInstance
        ? await workflow.getInternalInstance({ workflowName, instanceId: summary.id })
        : { id: summary.id, details: summary.details, meta: {} };
      matches.push({ orgId, workflowName, instance });
    }
  }

  return matches;
};

const buildStepBuilders = <
  TVars extends ScenarioVars,
>(): BackofficeScenarioStepBuilders<TVars> => ({
  given: {
    auth: {
      user: (input) =>
        createStep("given", "auth.user", `setup auth user ${input.id}`, async (ctx) => {
          await setUpScenarioAuthUser(ctx.runtime, input);
        }),
      organization: (input) =>
        createStep(
          "given",
          "auth.organization",
          `setup auth organization ${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.id);
            await setUpScenarioAuthOrganization(ctx.runtime, input);
          },
          { drain: false },
        ),
      member: (input) =>
        createStep(
          "given",
          "auth.member",
          `setup auth member ${input.userId} in ${input.orgId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await setUpScenarioAuthMember(ctx.runtime, input);
          },
        ),
    },
    organization: {
      exists: (input) =>
        createStep(
          "given",
          "organization.exists",
          `setup organization ${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.id);
            const ownerUserId = input.ownerUserId ?? "user-1";
            await setUpScenarioAuthUser(ctx.runtime, {
              id: ownerUserId,
              email: `${ownerUserId}@scenario.test`,
              role: "user",
              status: "active",
            });
            await setUpScenarioAuthOrganization(ctx.runtime, {
              id: input.id,
              slug: input.slug,
              name: input.name,
              ownerUserId,
              ownerRoles: input.ownerRoles,
            });
            ctx.vars[`organization:${input.id}`] = {
              id: input.id,
              name: input.name,
              ownerUserId,
            };
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: input.id, jurisdiction: null })
              .commands.seedStarterAutomationRoutes();
          },
          { drain: false },
        ),
    },
    marketplace: {
      entries: (entries) =>
        createStep(
          "given",
          "marketplace.entries",
          `insert marketplace entries ${entries
            .map(
              (entry) =>
                `${marketplaceListingId({ ownerScope: entry.owner.scope, slug: entry.slug })}@${entry.version}`,
            )
            .join(", ")}`,
          async (ctx) => {
            const result = await ctx.runtime.objects.marketplace
              .singleton()
              .commands.insertStaticEntries({
                entries: [...entries],
              });
            if (!result.ok) {
              throw new Error(`${result.error.code}: ${result.error.message}`);
            }
          },
          { drain: false },
        ),
    },
    telegram: {
      configured: (input) =>
        createStep(
          "given",
          "telegram.configured",
          `configure Telegram for ${input.orgId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const webhookSecretToken = input.webhookSecretToken ?? "telegram-webhook-secret";
            await ctx.runtime.objects.telegram
              .for({ kind: "org", orgId: input.orgId, jurisdiction: null })
              .commands.setAdminConfig({
                orgId: input.orgId,
                botToken: input.botToken ?? "123456:telegram-bot-token",
                webhookSecretToken,
                botUsername: input.botUsername,
                apiBaseUrl: input.apiBaseUrl ?? "https://telegram.test",
              });
            ctx.vars[`telegram:${input.orgId}:webhookSecretToken`] = webhookSecretToken;
          },
        ),
    },
    store: {
      entry: (input) =>
        createStep(
          "given",
          "store.entry",
          `setup store ${input.orgId}:${input.key}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await getStore(ctx, input.orgId).set({
              key: input.key,
              value: input.value,
            });
          },
        ),
    },
    identity: {
      binding: (input) =>
        createStep(
          "given",
          "identity.binding",
          `bind ${input.source ?? "telegram"}:${input.externalId} to ${input.userId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const scope = { kind: "org" as const, orgId: input.orgId, jurisdiction: null };
            await ctx.runtime.objects.automations.for(scope).commands.bindExternalIdentity(
              {
                identity: {
                  scope: "external",
                  source: input.source ?? "telegram",
                  type: input.externalType ?? "chat",
                  id: input.externalId,
                },
                userId: input.userId,
                verifiedByClaimId:
                  input.verifiedByClaimId ??
                  `scenario:${input.source ?? "telegram"}:${input.externalId}:${input.userId}`,
              },
              { execution: createBackofficeSystemExecution(scope) },
            );
          },
        ),
    },
    router: {
      route: (input) =>
        createStep(
          "given",
          "router.route",
          input.label ?? `setup route ${input.orgId}:${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const { orgId, label: _label, ...route } = input;
            await getRouter(ctx, orgId).createRoute(route);
          },
        ),
    },
    files: (input) =>
      createStep(
        "given",
        "files",
        `setup ${Object.keys(input.files).length} files for ${input.orgId}`,
        async (ctx) => {
          ctx.rememberOrg(input.orgId);
          const fs = ctx.files.forOrg(input.orgId);
          for (const [path, content] of Object.entries(input.files)) {
            await fs.writeFile(path, content);
          }
        },
        { drain: false },
      ),
    codemode: {
      run: (input) =>
        createStep(
          "given",
          "codemode.run",
          input.label ?? `setup codemode for ${backofficeContextScopeRoutePath(input.scope)}`,
          async (ctx) => {
            await ctx.runCodemode(input);
          },
        ),
      storeSet: (input) =>
        createStep(
          "given",
          "codemode.storeSet",
          `setup store ${input.orgId}:${input.key} through codemode`,
          async (ctx) => {
            await ctx.runCodemode({
              scope: { kind: "org", orgId: input.orgId, jurisdiction: null },
              label: `set store ${input.key}`,
              code: `async () => {
  await store.set(${JSON.stringify({
    key: input.key,
    value: input.value,
  })});
}`,
              assertToolCalls: ["store.set"],
            });
          },
        ),
      writeFile: (input) =>
        createStep(
          "given",
          "codemode.writeFile",
          `write file ${input.orgId}:${input.path} through codemode`,
          async (ctx) => {
            await ctx.runCodemode({
              scope: { kind: "org", orgId: input.orgId, jurisdiction: null },
              label: `write file ${input.path}`,
              code:
                input.content instanceof Uint8Array
                  ? `async () => {
  await state.writeFileBytes({ path: ${JSON.stringify(input.path)}, content: new Uint8Array(${JSON.stringify(
    [...input.content],
  )}) });
}`
                  : `async () => {
  await state.writeFile({ path: ${JSON.stringify(input.path)}, content: ${JSON.stringify(input.content)} });
}`,
            });
          },
        ),
    },
    direct: {
      storeEntry: (input) =>
        createStep(
          "given",
          "direct.storeEntry",
          `setup store ${input.orgId}:${input.key}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await getStore(ctx, input.orgId).set({
              key: input.key,
              value: input.value,
            });
          },
        ),
      file: (input) =>
        createStep(
          "given",
          "direct.file",
          `write file ${input.orgId}:${input.path}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await ctx.files.forOrg(input.orgId).writeFile(input.path, input.content);
          },
        ),
    },
  },
  when: {
    auth: {
      signUp: (input) =>
        createStep("when", "auth.signUp", `sign up ${input.email}`, async (ctx) => {
          const created = await ctx.runtime.objects.otp.singleton().commands.createAccessCode({
            label: `Scenario sign-up for ${input.email}`,
            codeSource: "random",
            expiresInDays: null,
          });
          if (!created.ok) {
            throw new Error("A random scenario access code was already taken.");
          }
          const accessCode = created.accessCode.code;

          const response = await scenarioAuthRequest(
            ctx,
            "/sign-up/email",
            {
              body: {
                name: input.email.split("@", 1)[0] || input.email,
                email: input.email,
                password: input.password ?? "password123",
                accessCode,
              },
            },
            input.origin,
          );
          if (!response.ok) {
            throw new Error(`Auth sign-up failed (${response.status}): ${await response.text()}`);
          }
          if (input.onboarding !== "pending") {
            await ctx.runtime.objects.auth
              .singleton()
              .commands.applyScenarioFixture({ onboardedEmails: [input.email] });
          }
          if (input.captureSessionCookieAs) {
            const cookie = scenarioAuthCookie(response);
            if (!cookie) {
              throw new Error(`Auth sign-up for ${input.email} did not issue a session cookie.`);
            }
            ctx.vars[input.captureSessionCookieAs] = cookie;
          }
        }),
      createOrganization: (input) =>
        createStep(
          "when",
          "auth.createOrganization",
          `create auth organization ${input.slug}`,
          async (ctx) => {
            const response = await scenarioAuthRequest(ctx, "/organization/create", {
              cookie: await resolveScenarioValue(ctx, input.cookie),
              body: { name: input.name, slug: input.slug },
            });
            if (!response.ok) {
              throw new Error(
                `Auth organization creation failed (${response.status}): ${await response.text()}`,
              );
            }
            if (input.captureOrganizationIdAs) {
              const organization = (await response.json()) as { id?: unknown };
              if (typeof organization.id !== "string") {
                throw new Error("Auth organization creation returned no organization id.");
              }
              ctx.vars[input.captureOrganizationIdAs] = organization.id;
            }
          },
        ),
      inviteMember: (input) =>
        createStep(
          "when",
          "auth.inviteMember",
          `invite ${input.email} to auth organization`,
          async (ctx) => {
            const response = await scenarioAuthRequest(ctx, "/organization/invite-member", {
              cookie: await resolveScenarioValue(ctx, input.cookie),
              body: {
                organizationId: await resolveScenarioValue(ctx, input.organizationId),
                email: input.email,
                role: input.role ?? "member",
              },
            });
            if (!response.ok) {
              throw new Error(
                `Auth member invitation failed (${response.status}): ${await response.text()}`,
              );
            }
            if (input.captureInvitationIdAs) {
              const invitation = (await response.json()) as { id?: unknown };
              if (typeof invitation.id !== "string") {
                throw new Error("Auth member invitation returned no invitation id.");
              }
              ctx.vars[input.captureInvitationIdAs] = invitation.id;
            }
          },
        ),
      acceptInvitation: (input) =>
        createStep(
          "when",
          "auth.acceptInvitation",
          "accept auth organization invitation",
          async (ctx) => {
            const response = await scenarioAuthRequest(ctx, "/organization/accept-invitation", {
              cookie: await resolveScenarioValue(ctx, input.cookie),
              body: { invitationId: await resolveScenarioValue(ctx, input.invitationId) },
            });
            if (!response.ok) {
              throw new Error(
                `Accepting Auth invitation failed (${response.status}): ${await response.text()}`,
              );
            }
          },
        ),
      signOut: (input) =>
        createStep("when", "auth.signOut", "sign out auth session", async (ctx) => {
          const response = await scenarioAuthRequest(ctx, "/sign-out", {
            cookie: await resolveScenarioValue(ctx, input.cookie),
            body: {},
          });
          if (!response.ok) {
            throw new Error(`Auth sign-out failed (${response.status}): ${await response.text()}`);
          }
        }),
      organizationCreated: (input) =>
        createStep(
          "when",
          "auth.organizationCreated",
          `ingest auth organization.created for ${input.id}`,
          (ctx) => ingestAutomationEvent(ctx, buildOrganizationCreatedEvent(input)),
        ),
      setUserRole: (input) =>
        createStep("when", "auth.setUserRole", `set ${input.userId} role to ${input.role}`, (ctx) =>
          setScenarioAuthUserRole(ctx.runtime, input),
        ),
      setUserStatus: (input) =>
        createStep(
          "when",
          "auth.setUserStatus",
          `set ${input.userId} status to ${input.status}`,
          (ctx) => setScenarioAuthUserStatus(ctx.runtime, input),
        ),
      setMemberRoles: (input) =>
        createStep(
          "when",
          "auth.setMemberRoles",
          `set ${input.userId} roles in ${input.orgId}`,
          (ctx) => setScenarioAuthMemberRoles(ctx.runtime, input),
        ),
      removeMember: (input) =>
        createStep(
          "when",
          "auth.removeMember",
          typeof input.userId === "string" && typeof input.orgId === "string"
            ? `remove ${input.userId} from ${input.orgId}`
            : "remove a member from an organization",
          async (ctx) => {
            await removeScenarioAuthMember(ctx.runtime, {
              orgId: await resolveScenarioValue(ctx, input.orgId),
              userId: await resolveScenarioValue(ctx, input.userId),
            });
          },
        ),
    },
    marketplace: {
      install: (input) =>
        createStep(
          "when",
          "marketplace.install",
          `install Marketplace entry ${input.slug}@${input.version} into ${backofficeContextScopeRoutePath(input.targetScope)}:${input.installationRoot}`,
          async (ctx) => {
            const targetOrgId = backofficeScopeOrganization(input.targetScope).orgId;
            ctx.rememberOrg(targetOrgId);
            const entry = getStaticMarketplaceEntry({
              slug: input.slug,
              version: input.version,
            });
            if (!entry) {
              throw new Error(
                `Scenario Marketplace installation could not find static entry '${input.slug}@${input.version}'.`,
              );
            }

            const listingId = marketplaceListingId({
              ownerScope: entry.owner.scope,
              slug: entry.slug,
            });
            const automations = ctx.runtime.objects.automations.for({
              kind: "org",
              orgId: targetOrgId,
              jurisdiction: null,
            });

            await ctx.runtime.objects.automations
              .singleton()
              .commands.requestStaticMarketplacePublications();
            await ctx.drain();

            const requested = await automations.commands.requestMarketplaceIngestion(
              {
                marketplace: { kind: "system" },
                listingId,
                version: entry.version,
                targetScope: input.targetScope,
                installationRoot: input.installationRoot,
                permissions: bundledMarketplacePermissions(entry),
              },
              {
                execution: createBackofficeSystemExecution({
                  kind: "org",
                  orgId: targetOrgId,
                  jurisdiction: null,
                }),
                propagationContext: null,
              },
            );
            if (requested.state === "failed") {
              throw new Error(
                `Scenario Marketplace installation request failed for '${listingId}@${entry.version}': ${requested.error.message}`,
              );
            }

            await ctx.drain();

            const execution = createBackofficeSystemExecution(input.targetScope);
            const installedFileSystem = createStateShellFileSystem(
              createRuntimeStateBackend({
                runtime: ctx.runtime.services,
                kernel: new BackofficeKernel(ctx.runtime.services),
                execution,
              }),
            );
            const installation = await ctx.runtime.objects.automations
              .for(input.targetScope)
              .commands.getPackageInstallation({ listingId });
            if (
              installation?.version !== entry.version ||
              installation.installationRoot !== input.installationRoot
            ) {
              throw new Error(
                `Scenario Marketplace installation did not complete for '${listingId}@${entry.version}'.`,
              );
            }
            const scenarioFileSystem =
              input.targetScope.kind === "project"
                ? ctx.files.forProject(input.targetScope.projectId)
                : ctx.files.forOrg(targetOrgId);

            // Scenario workflow execution uses a session filesystem, while Marketplace ingestion
            // writes through Upload. Mirror the installed result so later steps execute those files.
            for (const relativePath of Object.keys(entry.files)) {
              if (isMarketplaceInternalPackagePath(relativePath)) {
                continue;
              }
              const workspacePath = `${input.installationRoot}/${relativePath}`;
              await scenarioFileSystem.writeFile(
                workspacePath,
                await installedFileSystem.readFileBuffer(workspacePath),
              );
            }
          },
          { drain: false },
        ),
    },
    capability: {
      configured: (input) =>
        createStep(
          "when",
          "capability.configured",
          `ingest ${input.capabilityId} capability.configured for ${input.orgId}`,
          (ctx) => ingestAutomationEvent(ctx, buildCapabilityConfiguredEvent(input)),
        ),
    },
    automation: {
      ingestEvent: (input) =>
        createStep(
          "when",
          "automation.ingestEvent",
          `ingest automation event ${input.source}/${input.eventType}`,
          (ctx) => ingestAutomationEvent(ctx, input),
        ),
    },
    identity: {
      revoke: (input) =>
        createStep(
          "when",
          "identity.revoke",
          `revoke ${input.source ?? "telegram"}:${input.externalId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const scope = { kind: "org" as const, orgId: input.orgId, jurisdiction: null };
            await ctx.runtime.objects.automations.for(scope).commands.revokeExternalIdentity(
              {
                identity: {
                  scope: "external",
                  source: input.source ?? "telegram",
                  type: input.externalType ?? "chat",
                  id: input.externalId,
                },
                expectedUserId: input.expectedUserId,
                expectedVersion: input.expectedVersion ?? 0,
              },
              { execution: createBackofficeSystemExecution(scope) },
            );
          },
        ),
    },
    router: {
      seedStarter: (input) =>
        createStep(
          "when",
          "router.seedStarter",
          `seed starter routes for ${input.orgId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await ctx.runtime.objects.automations
              .for({ kind: "org", orgId: input.orgId, jurisdiction: null })
              .commands.seedStarterAutomationRoutes();
          },
        ),
      createRoute: (input) =>
        createStep(
          "when",
          "router.createRoute",
          input.label ?? `create route ${input.orgId}:${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const { orgId, label: _label, ...route } = input;
            await getRouter(ctx, orgId).createRoute(route);
          },
        ),
      updateRoute: (input) =>
        createStep(
          "when",
          "router.updateRoute",
          input.label ?? `update route ${input.orgId}:${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const { orgId, label: _label, ...patch } = input;
            const route = await getRouter(ctx, orgId).updateRoute(patch);
            if (!route) {
              throw new Error(`Automation route ${input.id} was not found.`);
            }
          },
        ),
    },
    project: {
      create: (input) =>
        createStep(
          "when",
          "project.create",
          input.label ??
            `create project ${backofficeScopePathSegment(input.owner)}:${input.slug ?? input.name}`,
          async (ctx) => {
            const organization = backofficeScopeOrganization(input.owner);
            if (organization) {
              ctx.rememberOrg(organization.orgId);
            }
            const response = await ctx.runtime.objects.automations.for(input.owner).http.fetch(
              new Request("https://automations.local/api/automations/projects", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  slug: input.slug,
                  name: input.name,
                  description: input.description,
                  createdByUserId: input.createdByUserId,
                }),
              }),
            );

            if (!response.ok) {
              throw new Error(
                `Project creation failed (${response.status}): ${await response.text()}`,
              );
            }

            if (input.captureIdAs) {
              const project = (await response.json()) as { id: unknown };
              ctx.vars[input.captureIdAs] = scenarioIdString(project.id);
            }
          },
        ),
    },
    codemode: {
      run: (input) =>
        createStep(
          "when",
          "codemode.run",
          input.label ?? `run codemode for ${backofficeContextScopeRoutePath(input.scope)}`,
          async (ctx) => {
            await ctx.runCodemode(input);
          },
        ),
    },
    telegram: {
      webhook: (input) =>
        createStep(
          "when",
          "telegram.webhook",
          input.label ?? `receive Telegram webhook for ${input.orgId}`,
          (ctx) => postTelegramWebhook(ctx, input.orgId, input.update),
        ),
      receivesMessage: (input) =>
        createStep(
          "when",
          "telegram.receivesMessage",
          `receive Telegram ${input.text} from chat ${input.chatId}`,
          (ctx) => postTelegramWebhook(ctx, input.orgId, buildTelegramMessageUpdate(input)),
        ),
    },
    workflow: {
      createInstance: (input) =>
        createStep(
          "when",
          "workflow.createInstance",
          input.label ??
            `create workflow ${input.remoteWorkflowName ?? input.workflowName ?? input.instanceId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const scenarioContext = ctx as BackofficeScenarioContext<TVars>;
            const executionPromise = input.execution
              ? resolveScenarioValue(scenarioContext, input.execution)
              : Promise.resolve(undefined);
            const workflowName = input.workflowName ?? CODEMODE_WORKFLOW;

            if ("path" in input && input.path) {
              if (workflowName !== CODEMODE_WORKFLOW) {
                throw new Error("Saved workflow paths use the codemode workflow host.");
              }
              const [execution, event, program] = await Promise.all([
                executionPromise,
                resolveScenarioValue(scenarioContext, input.event),
                readSavedWorkflowProgram({
                  path: input.path,
                  readFile: async (path) =>
                    await ctx.files.forOrg(input.orgId).readFile(path, "utf-8"),
                }),
              ]);
              const prepared = prepareCodemodeWorkflowInstance({
                program,
                instanceId: input.instanceId,
              });
              if (
                input.remoteWorkflowName &&
                prepared.remoteWorkflowName !== input.remoteWorkflowName
              ) {
                throw new Error(
                  `Codemode program '${input.path}' declares workflow '${prepared.remoteWorkflowName}', expected '${input.remoteWorkflowName}'.`,
                );
              }
              const workflowInput = createCodemodeWorkflowInstanceInput({
                prepared,
                trigger: { type: "event", event },
                execution: execution ?? {
                  kind: "deferred",
                  scopeRestriction: null,
                  scope: event.scope,
                  actors: event.actors,
                },
                replyTo: input.replyTo ?? null,
              });
              await getWorkflow(ctx, input.orgId, execution).createInternalInstance(workflowInput);
              return;
            }

            const [execution, params] = await Promise.all([
              executionPromise,
              resolveScenarioValue(scenarioContext, input.params),
            ]);
            await getWorkflow(ctx, input.orgId, execution).createInternalInstance({
              workflowName,
              remoteWorkflowName: input.remoteWorkflowName,
              instanceId: input.instanceId,
              params,
            });
          },
        ),
      sendEvent: (input) =>
        createStep(
          "when",
          "workflow.sendEvent",
          input.label ?? `send workflow event ${input.type} to ${input.instanceId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await getWorkflow(ctx, input.orgId).sendInternalEvent({
              workflowName: input.workflowName ?? CODEMODE_WORKFLOW,
              instanceId: input.instanceId,
              type: input.type,
              payload: await resolveScenarioValue(
                ctx as BackofficeScenarioContext<TVars>,
                input.payload,
              ),
            });
          },
        ),
    },
    otp: {
      confirmClaim: (input) =>
        createStep(
          "when",
          "otp.confirmClaim",
          `ingest OTP claim completion ${input.otpId}`,
          (ctx) => ingestAutomationEvent(ctx, buildIdentityClaimCompletedEvent(input)),
        ),
      confirmClaimFromCapturedUrl: (input) =>
        createStep(
          "when",
          "otp.confirmClaimFromCapturedUrl",
          `confirm OTP claim from ${input.url}`,
          async (ctx) => {
            const captured = ctx.vars[input.url];
            if (typeof captured !== "string") {
              throw new Error(`No captured URL found in scenario vars at ${input.url}.`);
            }

            const url = new URL(captured);
            const orgId = /\/backoffice\/claims\/([^/]+)\/complete/u.exec(url.pathname)?.[1];
            const externalId = url.searchParams.get("externalId");
            const code = url.searchParams.get("code");
            if (!orgId || !externalId || !code) {
              throw new Error(`Captured URL is not a Backoffice claim completion URL: ${captured}`);
            }

            ctx.rememberOrg(orgId);
            const result = await ctx.runtime.objects.otp
              .for({ kind: "org", orgId: orgId, jurisdiction: null })
              .commands.confirmIdentityClaim(
                {
                  externalId,
                  code,
                },
                createBackofficeRequestExecution({
                  scope: { kind: "org", orgId, jurisdiction: null },
                  verifiedRequestAuthority: {
                    userId: input.subjectUserId,
                    personalScope: {
                      kind: "user",
                      userId: input.subjectUserId,
                      jurisdiction: null,
                    },
                    role: "user",
                    organization: { kind: "org", orgId, jurisdiction: null },
                    administeredMember: null,
                    expiresAt: new Date(Date.now() + 60_000),
                    scopeRestriction: null,
                  },
                }),
              );
            if (!result.ok) {
              throw new Error(`OTP claim confirmation failed: ${JSON.stringify(result)}`);
            }
          },
        ),
    },
    time: {
      advance: (duration) =>
        createStep("when", "time.advance", `advance time by ${duration}`, (ctx) => {
          ctx.runtime.advanceTime(parseScenarioDurationMs(duration));
        }),
    },
  },
  // eslint-disable-next-line unicorn/no-thenable -- `then` is the requested assertion namespace.
  then: {
    auth: {
      authority: (input) =>
        createStep(
          "then",
          "auth.authority",
          `assert authority for ${input.userId}`,
          async (ctx) => {
            const actual = await ctx.runtime.objects.auth
              .singleton()
              .commands.getUserAuthorityFacts({
                userId: input.userId,
                ...(input.orgId ? { organizationId: input.orgId } : {}),
              });
            if (
              actual.active !== input.expected.active ||
              actual.role !== input.expected.role ||
              (actual.organization !== null) !== input.expected.organizationMember
            ) {
              throw new Error(
                `Expected auth authority ${JSON.stringify(input.expected)}, got ${JSON.stringify(actual)}.`,
              );
            }
          },
        ),
      member: (input) =>
        createStep(
          "then",
          "auth.member",
          `assert auth member ${input.userId} in ${input.orgId}`,
          async (ctx) => {
            const actual = await getScenarioAuthMemberRoles(ctx.runtime, input);
            if (!actual) {
              throw new Error(`Expected ${input.userId} to be a member of ${input.orgId}.`);
            }
            const expected = normalizeScenarioAuthRoles(input.roles);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              throw new Error(
                `Expected auth member roles ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
              );
            }
          },
        ),
      permissions: (input) =>
        createStep(
          "then",
          "auth.permissions",
          `assert permissions for ${input.userId}`,
          async (ctx) => {
            const execution = createBackofficeUserExecution({
              scope: input.scope,
              userId: input.userId,
            });
            const principal = execution.actors.principal;
            if (!principal) {
              throw new Error("Scenario user execution did not produce a principal.");
            }
            const permissions =
              await ctx.runtime.services.authorityResolver.resolvePrincipalPermissions({
                principal,
                execution,
              });
            const actual = new Set(permissions.map(permissionKey));
            const missing = (input.include ?? []).filter(
              (permission) => !actual.has(permissionKey(permission)),
            );
            const unexpected = (input.exclude ?? []).filter((permission) =>
              actual.has(permissionKey(permission)),
            );
            if (missing.length > 0 || unexpected.length > 0) {
              throw new Error(
                `Permission assertion failed: ${JSON.stringify({ missing, unexpected, actual: [...actual] })}.`,
              );
            }
          },
        ),
      sessionWithoutOrganization: (input) =>
        createStep(
          "then",
          "auth.sessionWithoutOrganization",
          "assert auth session has no organization",
          async (ctx) => {
            const response = await scenarioAuthRequest(ctx, "/backoffice-token", {
              cookie: await resolveScenarioValue(ctx, input.cookie),
              body: { selection: "preferred" },
            });
            if (!response.ok) {
              throw new Error(`Backoffice token exchange failed (${response.status}).`);
            }
            const result = issueBackofficeTokenResultSchema.parse(await response.json());
            if (result.organization !== null) {
              throw new Error(
                `Expected no organization, got ${JSON.stringify(result.organization)}.`,
              );
            }
          },
        ),
      sessionHasOrganization: (input) =>
        createStep(
          "then",
          "auth.sessionHasOrganization",
          "assert auth session organization membership",
          async (ctx) => {
            const organizationId = await resolveScenarioValue(ctx, input.organizationId);
            const response = await scenarioAuthRequest(ctx, "/backoffice-token", {
              cookie: await resolveScenarioValue(ctx, input.cookie),
              body: { selection: "required", organizationId },
            });
            if (!response.ok) {
              throw new Error(`Expected Backoffice token access to ${organizationId}.`);
            }
          },
        ),
      signedOut: (input) =>
        createStep("then", "auth.signedOut", "assert auth session is signed out", async (ctx) => {
          const response = await scenarioAuthRequest(ctx, "/get-session", {
            cookie: await resolveScenarioValue(ctx, input.cookie),
          });
          if (!response.ok || (await response.json()) !== null) {
            throw new Error("Expected the Auth session to be signed out.");
          }
        }),
    },
    automation: {
      event: (input) =>
        createStep(
          "then",
          "automation.event",
          `assert automation event ${input.where.id ?? `${input.where.source ?? "*"}:${input.where.eventType ?? "*"}`}`,
          async (ctx) => {
            if (!input.where.id && !input.where.source && !input.where.eventType) {
              throw new Error("Automation event assertions require at least one selector.");
            }

            const response = await ctx.runtime.objects.automations
              .for(input.scope)
              .http.fetch(new Request("https://automations.test/api/automations/events?limit=500"));
            if (!response.ok) {
              throw new Error(`Automation event listing returned ${response.status}.`);
            }

            const result = automationEventListResultSchema.parse(await response.json());
            const selected = result.events.filter(
              (event) =>
                (!input.where.id || event.id === input.where.id) &&
                (!input.where.source || event.source === input.where.source) &&
                (!input.where.eventType || event.eventType === input.where.eventType),
            );
            if (selected.length === 0) {
              throw new Error(
                `Expected automation event was not found: ${JSON.stringify(input.where)}.`,
              );
            }

            for (const event of selected) {
              try {
                assertPartialMatch(event, input.expected, "automation.event");
                return;
              } catch {
                // Continue through events selected by source/type until one matches the expectation.
              }
            }

            throw new Error(
              `No automation event matched ${JSON.stringify(input.expected)}. Selected events: ${JSON.stringify(selected, null, 2)}.`,
            );
          },
        ),
    },
    identity: {
      resolves: (input) =>
        createStep(
          "then",
          "identity.resolves",
          `assert ${input.identity.source}:${input.identity.type}:${input.identity.id} resolves to ${input.userId}`,
          async (ctx) => {
            const result = await ctx.runtime.objects.automations
              .for(input.scope)
              .commands.resolveExternalIdentity(
                { identity: input.identity },
                { execution: createBackofficeSystemExecution(input.scope) },
              );
            if (result?.userId !== input.userId) {
              throw new Error(
                `Expected identity to resolve to ${input.userId}, got ${JSON.stringify(result)}.`,
              );
            }
          },
        ),
      unresolved: (input) =>
        createStep(
          "then",
          "identity.unresolved",
          `assert ${input.identity.source}:${input.identity.type}:${input.identity.id} is unresolved`,
          async (ctx) => {
            const result = await ctx.runtime.objects.automations
              .for(input.scope)
              .commands.resolveExternalIdentity(
                { identity: input.identity },
                { execution: createBackofficeSystemExecution(input.scope) },
              );
            if (result !== null) {
              throw new Error(`Expected identity to be unresolved, got ${JSON.stringify(result)}.`);
            }
          },
        ),
    },
    kernel: {
      action: (input) =>
        createStep(
          "then",
          "kernel.action",
          `assert kernel action ${permissionKey(input.operation)}`,
          (ctx) => {
            const selected = ctx.kernelActions.filter(
              (action) => permissionKey(action.operation) === permissionKey(input.operation),
            );

            for (const action of selected) {
              try {
                assertPartialMatch(action.execution.scope, input.scope, "kernel.action.scope");
                if (input.actors) {
                  assertPartialMatch(action.execution.actors, input.actors, "kernel.action.actors");
                }
                if (typeof input.resource !== "undefined") {
                  assertPartialMatch(action.resource, input.resource, "kernel.action.resource");
                }
                return;
              } catch {
                // Continue through repeated operations until the expected execution is found.
              }
            }

            throw new Error(
              `No kernel action matched ${JSON.stringify(input)}. Selected actions: ${JSON.stringify(selected, null, 2)}.`,
            );
          },
        ),
    },
    telegram: {
      sentMessage: (input) =>
        createStep(
          "then",
          "telegram.sentMessage",
          `assert Telegram sent ${String(input.text)}`,
          (ctx) => {
            const telegram = ctx.fakes.telegram;
            if (!telegram) {
              throw new Error("No fake Telegram API is configured for this scenario.");
            }

            const call = telegram.sendMessageCalls.find((candidate) => {
              const chatId = String(candidate.body.chat_id ?? "");
              const text = String(candidate.body.text ?? "");
              return (!input.chatId || chatId === input.chatId) && textMatches(text, input.text);
            });

            if (!call) {
              throw new Error(
                `Expected Telegram sendMessage call was not found. Calls: ${JSON.stringify(
                  telegram.sendMessageCalls,
                  null,
                  2,
                )}`,
              );
            }

            if (input.captureUrlAs) {
              ctx.vars[input.captureUrlAs] = extractFirstUrl(String(call.body.text ?? ""));
            }
          },
          { drain: false },
        ),
      noMessages: () =>
        createStep("then", "telegram.noMessages", "assert Telegram sent no messages", (ctx) => {
          const calls = ctx.fakes.telegram?.sendMessageCalls ?? [];
          if (calls.length > 0) {
            throw new Error(`Expected no Telegram messages, got ${JSON.stringify(calls, null, 2)}`);
          }
        }),
      sentChatAction: (input) =>
        createStep(
          "then",
          "telegram.sentChatAction",
          `assert Telegram sent ${input.action} action`,
          (ctx) => {
            const calls = ctx.fakes.telegram?.sendChatActionCalls ?? [];
            const call = calls.find((candidate) => {
              const chatId = String(candidate.body.chat_id ?? "");
              const action = String(candidate.body.action ?? "");
              return (!input.chatId || chatId === input.chatId) && action === input.action;
            });
            if (!call) {
              throw new Error(
                `Expected Telegram chat action was not found. Calls: ${JSON.stringify(
                  calls,
                  null,
                  2,
                )}`,
              );
            }
          },
          { drain: false },
        ),
    },
    pi: {
      provisionedAgent: (input) =>
        createStep(
          "then",
          "pi.provisionedAgent",
          "assert Pi agent was provisioned",
          (ctx) => {
            const calls = ctx.fakes.pi?.provisionedAgents ?? [];
            const call = calls.find(
              (candidate) => !input.agentName || candidate.agentName === input.agentName,
            );
            if (!call) {
              throw new Error(
                `Expected Pi agent provisioning was not found. Calls: ${JSON.stringify(
                  calls,
                  null,
                  2,
                )}`,
              );
            }
          },
          { drain: false },
        ),
      ranPrompt: (input) =>
        createStep(
          "then",
          "pi.ranPrompt",
          "assert Pi prompt was run",
          (ctx) => {
            const calls = ctx.fakes.pi?.turns ?? [];
            const call = calls.find((candidate) => {
              const assistantOk =
                typeof input.assistantText === "undefined"
                  ? true
                  : typeof input.assistantText === "string"
                    ? candidate.assistantText === input.assistantText
                    : input.assistantText.test(candidate.assistantText);
              return (
                (!input.agentName || candidate.agentName === input.agentName) &&
                (!input.content || candidate.content === input.content) &&
                assistantOk
              );
            });
            if (!call) {
              throw new Error(
                `Expected Pi turn was not found. Turns: ${JSON.stringify(calls, null, 2)}`,
              );
            }
          },
          { drain: false },
        ),
    },
    billing: {
      tracker: (input) =>
        createStep(
          "then",
          "billing.tracker",
          `assert ${input.meter} billing tracker for ${JSON.stringify(input.scope)}`,
          async (ctx) => {
            const owner = backofficeScopeRootOwner(input.scope);
            if (owner === null) {
              throw new Error("System work has no billing ledger.");
            }
            if (owner.kind === "org") {
              ctx.rememberOrg(owner.orgId);
            }
            const billing = ctx.runtime.objects.billing.for(owner);
            await ctx.runtime.drain();
            const page = await billing.commands.getTrackers({
              scope: input.scope,
              period: input.period,
              pageSize: 100,
            });
            const tracker = page.trackers.find((candidate) => candidate.meter === input.meter);
            if (!tracker) {
              throw new Error(
                `Expected billing tracker ${input.meter}, got ${JSON.stringify(page.trackers)}.`,
              );
            }
            if (tracker.quantity !== input.quantity) {
              throw new Error(
                `Expected billing tracker ${input.meter} quantity ${input.quantity}, got ${tracker.quantity}.`,
              );
            }
            if (input.eventCount && tracker.eventCount !== input.eventCount) {
              throw new Error(
                `Expected billing tracker ${input.meter} event count ${input.eventCount}, got ${tracker.eventCount}.`,
              );
            }
          },
        ),
    },
    resend: {
      queuedEmail: (input) =>
        createStep(
          "then",
          "resend.queuedEmail",
          "assert transactional email was queued",
          (ctx) => {
            const calls = ctx.fakes.resend?.queueEmailCalls ?? [];
            const call = calls.find((candidate) => {
              const recipients = Array.isArray(candidate.input.to)
                ? candidate.input.to
                : [candidate.input.to];
              const text = candidate.input.text ?? "";
              const textMatches =
                typeof input.text === "undefined"
                  ? true
                  : typeof input.text === "string"
                    ? text === input.text
                    : input.text.test(text);
              const keyMatches =
                typeof input.idempotencyKey === "undefined"
                  ? true
                  : typeof input.idempotencyKey === "string"
                    ? candidate.options.idempotencyKey === input.idempotencyKey
                    : input.idempotencyKey.test(candidate.options.idempotencyKey);

              return (
                (!input.to || recipients.includes(input.to)) &&
                (!input.subject || candidate.input.subject === input.subject) &&
                textMatches &&
                keyMatches
              );
            });

            if (!call) {
              throw new Error(
                `Expected queued Resend email was not found. Calls: ${JSON.stringify(calls, null, 2)}`,
              );
            }
          },
          { drain: false },
        ),
      noQueuedEmails: () =>
        createStep(
          "then",
          "resend.noQueuedEmails",
          "assert no transactional emails were queued",
          (ctx) => {
            const calls = ctx.fakes.resend?.queueEmailCalls ?? [];
            if (calls.length !== 0) {
              throw new Error(`Expected no queued Resend emails. Calls: ${JSON.stringify(calls)}`);
            }
          },
          { drain: false },
        ),
      repliedToThread: (input) =>
        createStep(
          "then",
          "resend.repliedToThread",
          "assert Resend thread reply was sent",
          (ctx) => {
            const calls = ctx.fakes.resend?.replyCalls ?? [];
            const call = calls.find((candidate) => {
              const text = String(candidate.body.text ?? "");
              const bodyOk =
                typeof input.body === "undefined"
                  ? true
                  : typeof input.body === "string"
                    ? text === input.body
                    : input.body.test(text);
              return (!input.threadId || candidate.threadId === input.threadId) && bodyOk;
            });
            if (!call) {
              throw new Error(
                `Expected Resend reply call was not found. Calls: ${JSON.stringify(
                  calls,
                  null,
                  2,
                )}`,
              );
            }
          },
          { drain: false },
        ),
    },
    store: {
      entry: (input) =>
        createStep(
          "then",
          "store.entry",
          `assert store ${input.orgId}:${input.key}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const entry = await getStore(ctx, input.orgId).get({ key: input.key });
            if (!entry) {
              throw new Error(`Expected store entry ${input.key} to exist.`);
            }
            if (entry.value !== input.value) {
              throw new Error(
                `Expected store entry ${input.key} value ${JSON.stringify(input.value)}, got ${JSON.stringify(
                  entry.value,
                )}.`,
              );
            }
          },
        ),
      missing: (input) =>
        createStep(
          "then",
          "store.missing",
          `assert store missing ${input.orgId}:${input.key}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const entry = await getStore(ctx, input.orgId).get({ key: input.key });
            if (entry) {
              throw new Error(
                `Expected store entry ${input.key} to be missing, got ${JSON.stringify(entry)}.`,
              );
            }
          },
        ),
      entries: (input) =>
        createStep(
          "then",
          "store.entries",
          `assert store entries for ${input.orgId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const entries = await getStore(ctx, input.orgId).list({
              prefix: input.prefix,
              limit: 500,
            });
            const missing = input.include.filter((expected) => {
              if (typeof expected === "string") {
                return !entries.some((entry) => entry.key === expected);
              }
              return !entries.some(
                (entry) =>
                  entry.key === expected.key &&
                  (typeof expected.value === "undefined" || entry.value === expected.value),
              );
            });
            if (missing.length > 0) {
              throw new Error(
                `Expected store entries were not found: ${JSON.stringify(
                  missing,
                )}. Entries: ${JSON.stringify(entries, null, 2)}`,
              );
            }
          },
        ),
    },
    router: {
      route: (input) =>
        createStep(
          "then",
          "router.route",
          `assert route ${input.orgId}:${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const route = await getRouter(ctx, input.orgId).getRoute({ id: input.id });
            if (!route) {
              throw new Error(`Expected automation route ${input.id} to exist.`);
            }

            const { orgId: _orgId, ...expected } = input;
            assertPartialMatch(route, expected, `route.${input.id}`);
          },
        ),
      missing: (input) =>
        createStep(
          "then",
          "router.missing",
          `assert route missing ${input.orgId}:${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const route = await getRouter(ctx, input.orgId).getRoute({ id: input.id });
            if (route) {
              throw new Error(
                `Expected automation route ${input.id} to be missing, got ${JSON.stringify(route)}.`,
              );
            }
          },
        ),
      routes: (input) =>
        createStep("then", "router.routes", `assert routes for ${input.orgId}`, async (ctx) => {
          ctx.rememberOrg(input.orgId);
          const routes = await getRouter(ctx, input.orgId).listRoutes();
          if (typeof input.count === "number" && routes.length !== input.count) {
            throw new Error(
              `Expected ${input.count} automation routes, got ${routes.length}: ${JSON.stringify(
                routes.map((route) => route.id),
              )}`,
            );
          }

          for (const expected of input.include ?? []) {
            if (typeof expected === "string") {
              if (!routes.some((route) => route.id === expected)) {
                throw new Error(
                  `Expected automation route ${expected} to exist. Routes: ${JSON.stringify(
                    routes.map((route) => route.id),
                  )}`,
                );
              }
              continue;
            }

            const route = routes.find((candidate) => candidate.id === expected.id);
            if (!route) {
              throw new Error(
                `Expected automation route ${expected.id} to exist. Routes: ${JSON.stringify(
                  routes.map((candidate) => candidate.id),
                )}`,
              );
            }
            assertPartialMatch(route, expected, `route.${expected.id}`);
          }

          const unexpected = (input.exclude ?? []).filter((id) =>
            routes.some((route) => route.id === id),
          );
          if (unexpected.length > 0) {
            throw new Error(`Expected routes to be missing: ${JSON.stringify(unexpected)}.`);
          }
        }),
    },
    workflow: {
      instance: (input) =>
        createStep(
          "then",
          "workflow.instance",
          `assert workflow ${input.remoteWorkflowName ?? input.instanceId ?? input.workflowName ?? "instance"}`,
          async (ctx) => {
            const matches = await findWorkflowInstances(ctx, input);
            if (matches.length === 0) {
              throw new Error(
                `Expected workflow instance was not found: ${JSON.stringify(input)}.`,
              );
            }

            const match = matches.find(({ instance }) =>
              input.status ? instance.details.status === input.status : true,
            );
            if (!match) {
              throw new Error(
                `No workflow instance matched status ${input.status}. Matches: ${JSON.stringify(
                  matches,
                  null,
                  2,
                )}`,
              );
            }

            if (input.waitingFor) {
              const currentStep = match.instance.meta.currentStep as
                | { waitEventType?: unknown; status?: unknown }
                | undefined;
              if (currentStep?.waitEventType !== input.waitingFor) {
                throw new Error(
                  `Expected workflow to wait for ${input.waitingFor}, got ${JSON.stringify(currentStep)}.`,
                );
              }
            }

            if (typeof input.params !== "undefined") {
              assertPartialMatch(match.instance.meta.params, input.params, "workflow.params");
            }

            if (typeof input.output !== "undefined") {
              assertPartialMatch(match.instance.details.output, input.output, "workflow.output");
            }

            if (input.actors) {
              const params = isRecord(match.instance.meta.params) ? match.instance.meta.params : {};
              const execution = isRecord(params.execution) ? params.execution : null;
              const metadata = isRecord(params.metadata) ? params.metadata : null;
              const actors = automationActorsSchema.parse(
                match.workflowName === CODEMODE_WORKFLOW
                  ? execution?.actors
                  : metadata?.[BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY],
              );
              assertPartialMatch(actors, input.actors, "workflow.actors");
            }
          },
        ),
      missing: (input) =>
        createStep(
          "then",
          "workflow.missing",
          `assert workflow ${input.remoteWorkflowName ?? input.instanceId ?? input.workflowName ?? "instance"} is missing`,
          async (ctx) => {
            const matches = await findWorkflowInstances(ctx, input);
            if (matches.length > 0) {
              throw new Error(
                `Expected workflow instance to be missing, found: ${JSON.stringify(
                  matches,
                  null,
                  2,
                )}`,
              );
            }
          },
        ),
      steps: (input) =>
        createStep(
          "then",
          "workflow.steps",
          `assert workflow steps ${input.remoteWorkflowName ?? input.instanceId ?? input.workflowName ?? "instance"}`,
          async (ctx) => {
            const matches = await findWorkflowInstances(ctx, input);
            if (matches.length === 0) {
              throw new Error(
                `Expected workflow instance was not found for steps assertion: ${JSON.stringify(
                  input,
                )}.`,
              );
            }

            const missingByInstance = [];
            for (const match of matches) {
              const history = await getWorkflow(ctx, match.orgId).getInternalHistory?.({
                workflowName: match.workflowName,
                instanceId: match.instance.id,
              });
              const stepNames = (history?.steps ?? [])
                .map((step) =>
                  step && typeof step === "object" && "name" in step
                    ? String((step as { name: unknown }).name)
                    : "",
                )
                .filter(Boolean);
              const missing = input.include.filter((name) => !stepNames.includes(name));
              if (missing.length === 0) {
                return;
              }
              missingByInstance.push({ instanceId: match.instance.id, missing, stepNames });
            }

            throw new Error(
              `Expected workflow steps were not found: ${JSON.stringify(
                missingByInstance,
                null,
                2,
              )}`,
            );
          },
        ),
      event: (input) =>
        createStep(
          "then",
          "workflow.event",
          `assert workflow event ${input.type ?? input.remoteWorkflowName ?? input.instanceId ?? input.workflowName ?? "event"}`,
          async (ctx) => {
            const matches = await findWorkflowInstances(ctx, input);
            if (matches.length === 0) {
              throw new Error(
                `Expected workflow instance was not found for event assertion: ${JSON.stringify(
                  input,
                )}.`,
              );
            }

            const missingByInstance = [];
            for (const match of matches) {
              const history = await getWorkflow(ctx, match.orgId).getInternalHistory?.({
                workflowName: match.workflowName,
                instanceId: match.instance.id,
              });
              const events = history?.events ?? [];
              const event = events.find((candidate) => {
                if (!candidate || typeof candidate !== "object") {
                  return false;
                }

                const record = candidate as {
                  type?: unknown;
                  payload?: unknown;
                  consumedByStepKey?: unknown;
                };
                if (input.type && record.type !== input.type) {
                  return false;
                }
                if (
                  "consumedByStepKey" in input &&
                  record.consumedByStepKey !== input.consumedByStepKey
                ) {
                  return false;
                }
                if (typeof input.payload !== "undefined") {
                  try {
                    assertPartialMatch(record.payload, input.payload, "workflow.event.payload");
                  } catch {
                    return false;
                  }
                }
                return true;
              });

              if (event) {
                return;
              }
              missingByInstance.push({ instanceId: match.instance.id, events });
            }

            throw new Error(
              `Expected workflow event was not found: ${JSON.stringify(
                missingByInstance,
                null,
                2,
              )}`,
            );
          },
        ),
      noErrored: (input = {}) =>
        createStep("then", "workflow.noErrored", "assert no workflows errored", async (ctx) => {
          const orgIds = input.orgId
            ? [input.orgId]
            : [SYSTEM_WORKFLOW_TARGET_ID, ...ctx.files.listOrgIds()];
          const errored = [];

          for (const orgId of orgIds) {
            const workflow = getWorkflow(ctx, orgId);
            const workflowList = await workflow.listInternalWorkflows?.();
            for (const entry of workflowList?.workflows ?? [{ name: "codemode-script" }]) {
              const response = await workflow.listInternalInstances?.({
                workflowName: entry.name,
                status: "errored",
                pageSize: 100,
              });
              for (const instance of response?.instances ?? []) {
                errored.push({
                  workflowName: entry.name,
                  instanceId: instance.id,
                  details: instance.details,
                });
              }
            }
          }

          if (errored.length > 0) {
            throw new Error(
              `Expected no errored workflows, got ${JSON.stringify(errored, null, 2)}`,
            );
          }
        }),
    },
    hooks: {
      noPending: (input = {}) =>
        createStep(
          "then",
          "hooks.noPending",
          "assert no durable hooks are pending",
          async (ctx) => {
            const orgIds = input.orgId ? [input.orgId] : ctx.files.listOrgIds();
            const fragments = input.fragments ?? listHookScopes().map((scope) => scope.id);
            const unfinished = [];

            for (const orgId of orgIds) {
              const hooks = getHooks(ctx, orgId);
              for (const fragment of fragments) {
                const queue = await hooks.listHooks({
                  fragment,
                  pageSize: 100,
                });
                const items = queue.items.filter((item) => item.status !== "completed");
                if (items.length > 0) {
                  unfinished.push({
                    fragment,
                    items,
                  });
                }
              }
            }

            if (unfinished.length > 0) {
              throw new Error(
                `Expected no pending durable hooks, got ${JSON.stringify(unfinished, null, 2)}`,
              );
            }
          },
        ),
      noFailed: (input = {}) =>
        createStep("then", "hooks.noFailed", "assert no durable hooks failed", async (ctx) => {
          const orgIds = input.orgId ? [input.orgId] : ctx.files.listOrgIds();
          const fragments = input.fragments ?? listInstantiatedHookFragments(ctx, orgIds);
          const failed = [];

          for (const orgId of orgIds) {
            const hooks = getHooks(ctx, orgId);
            for (const fragment of fragments) {
              let queue;
              try {
                queue = await hooks.listHooks({
                  fragment,
                  pageSize: 100,
                });
              } catch (cause) {
                if (isUnavailableHookRepositoryError(cause)) {
                  continue;
                }
                throw cause;
              }
              const items = queue.items.filter((item) => item.status === "failed");
              if (items.length > 0) {
                failed.push({
                  fragment,
                  items,
                });
              }
            }
          }

          if (failed.length > 0) {
            throw new Error(
              `Expected no failed durable hooks, got ${JSON.stringify(failed, null, 2)}`,
            );
          }
        }),
    },
    codemode: {
      toolCalls: (input) =>
        createStep(
          "then",
          "codemode.toolCalls",
          input.label ?? `assert codemode tool calls ${input.include.join(", ")}`,
          (ctx) => {
            const toolCalls = ctx.codemodeRuns.flatMap((run) => run.result.toolCalls);
            const missing = input.include.filter(
              (expected) => !toolCalls.some((call) => matchesToolCall(call, expected)),
            );
            if (missing.length > 0) {
              throw new Error(
                `Expected codemode tool calls ${missing.join(", ")}. Calls: ${JSON.stringify(
                  toolCalls,
                  null,
                  2,
                )}`,
              );
            }
          },
          { drain: false },
        ),
    },
    files: {
      exists: (input) =>
        createStep(
          "then",
          "files.exists",
          `assert file exists ${input.orgId}:${input.path}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            if (!(await getReadableScenarioFileSystem(ctx, input.orgId, input.path))) {
              throw new Error(`Expected file ${input.path} to exist.`);
            }
          },
        ),
      missing: (input) =>
        createStep(
          "then",
          "files.missing",
          `assert file missing ${input.orgId}:${input.path}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            if (await getReadableScenarioFileSystem(ctx, input.orgId, input.path)) {
              throw new Error(`Expected file ${input.path} to be missing.`);
            }
          },
        ),
      contains: (input) =>
        createStep(
          "then",
          "files.contains",
          `assert file contains ${input.orgId}:${input.path}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const fs = await getReadableScenarioFileSystem(ctx, input.orgId, input.path);
            if (!fs) {
              throw new Error(`Expected file ${input.path} to exist.`);
            }
            const content = await fs.readFile(input.path, "utf-8");
            const ok =
              typeof input.text === "string"
                ? content.includes(input.text)
                : input.text.test(content);
            if (!ok) {
              throw new Error(`Expected file ${input.path} to contain ${String(input.text)}.`);
            }
          },
        ),
      bytes: (input) =>
        createStep(
          "then",
          "files.bytes",
          `assert file bytes ${input.orgId}:${input.path}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const fs = await getReadableScenarioFileSystem(ctx, input.orgId, input.path);
            if (!fs) {
              throw new Error(`Expected file ${input.path} to exist.`);
            }
            const content = new Uint8Array(await fs.readFileBuffer(input.path));
            if (
              content.byteLength !== input.content.byteLength ||
              content.some((byte, index) => byte !== input.content[index])
            ) {
              throw new Error(
                `Expected file ${input.path} to hold ${input.content.byteLength} given bytes, got ${content.byteLength} other bytes.`,
              );
            }
          },
        ),
      jsonEquals: (input) =>
        createStep(
          "then",
          "files.jsonEquals",
          `assert file json ${input.orgId}:${input.path}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const fs = await getReadableScenarioFileSystem(ctx, input.orgId, input.path);
            if (!fs) {
              throw new Error(`Expected file ${input.path} to exist.`);
            }
            const content = await fs.readFile(input.path, "utf-8");
            const actual = JSON.parse(content) as unknown;
            if (JSON.stringify(actual) !== JSON.stringify(input.value)) {
              throw new Error(
                `Expected JSON file ${input.path} to equal ${JSON.stringify(input.value)}, got ${JSON.stringify(
                  actual,
                )}.`,
              );
            }
          },
        ),
      diff: (input) =>
        createStep("then", "files.diff", `assert file diff ${input.orgId}`, async (ctx) => {
          ctx.rememberOrg(input.orgId);
          ctx.files.rememberOrgPaths(
            input.orgId,
            (input.include ?? []).map((expected) =>
              typeof expected === "string" ? expected : expected.path,
            ),
          );
          const diff = await ctx.files.diff(input.orgId, async (path) => {
            const fs = await getReadableScenarioFileSystem(ctx, input.orgId, path);
            return fs ? await readSnapshotContent(fs, path) : null;
          });
          if (!input.include || input.include.length === 0) {
            if (diff.length === 0) {
              throw new Error(`Expected file diff for ${input.orgId}, got no changes.`);
            }
            return;
          }

          const missing = input.include.filter((expected) => {
            const path = typeof expected === "string" ? expected : expected.path;
            const status = typeof expected === "string" ? undefined : expected.status;
            return !diff.some(
              (entry) => entry.path === path && (status === undefined || entry.status === status),
            );
          });

          if (missing.length > 0) {
            throw new Error(
              `Expected file diff entries were not found: ${JSON.stringify(
                missing,
              )}. Diff: ${JSON.stringify(diff, null, 2)}`,
            );
          }
        }),
    },
    assert: (label, assertion) =>
      createStep(
        "then",
        "assert",
        label,
        (ctx) => assertion(ctx as BackofficeScenarioContext<TVars>),
        {
          drain: false,
        },
      ),
  },
  runner: {
    drain: () =>
      createStep("runner", "runner.drain", "drain Backoffice runtime", (ctx) => ctx.drain()),
    restartObject: (address) =>
      createStep(
        "runner",
        "runner.restartObject",
        `restart ${address.binding} Backoffice object`,
        (ctx) => ctx.runtime.restartObject(address),
        { drain: false },
      ),
    dropObjectAlarm: (address) =>
      createStep(
        "runner",
        "runner.dropObjectAlarm",
        `drop ${address.binding} Backoffice object alarm`,
        (ctx) => ctx.runtime.dropObjectAlarm(address),
        { drain: false },
      ),
  },
});

const fakeTelegramFile = (fakeTelegram: FakeTelegramApi, fileId: string): FakeTelegramFile => {
  const file = fakeTelegram.getFileFixture(fileId);
  if (!file) {
    throw new Error(`Fake Telegram file not found: ${fileId}`);
  }
  return file;
};

const createFakeObjectOverrides = async (fakes: ScenarioFakes): Promise<LocalBackofficeObjects> => {
  const overrides: LocalBackofficeObjects = {};

  if (fakes.telegram) {
    const { TelegramObject } = await import("../../../workers/telegram-object");
    overrides.TELEGRAM = ({ state, env, runtime, implementation, nowEpochMs }) => {
      const fakeTelegram = fakes.telegram!;
      return new (class extends TelegramObject {
        async getAutomationFile(input: {
          fileId: string;
        }): Promise<TelegramAutomationFileMetadata> {
          fakeTelegram.getFileCalls.push({ fileId: input.fileId });
          const file = fakeTelegramFile(fakeTelegram, input.fileId);
          return {
            fileId: file.fileId,
            fileUniqueId: file.fileUniqueId,
            filePath: file.filePath,
            fileSize: file.fileSize,
          };
        }

        protected override async downloadAutomationFile({
          fileId,
        }: {
          fileId: string;
        }): Promise<Response> {
          fakeTelegram.downloadFileCalls.push({ fileId });
          const file = fakeTelegramFile(fakeTelegram, fileId);
          return createTelegramAutomationFileResponse(
            new Response(file.bytes.slice(), {
              headers: file.contentType ? { "content-type": file.contentType } : undefined,
            }),
            file,
          );
        }
      })({
        state,
        env,
        runtime,
        implementation,
        nowEpochMs,
        api: fakeTelegram.api,
        adminApi: fakeTelegram.adminApi,
      });
    };
  }

  if (
    fakes.pi ||
    fakes.classifier ||
    fakes.openaiImages ||
    fakes.openaiDecisions ||
    fakes.openaiResponses ||
    fakes.workersAi
  ) {
    const { PiManagerObject } = await import("../../../workers/pi-manager-object");
    overrides.PI_MANAGER = ({
      state,
      env,
      runtime,
      implementation,
      nowEpochMs,
      getPiAgent,
      piAvailableModels,
    }) => {
      const fakePi = fakes.pi;
      return new PiManagerObject({
        state,
        env,
        runtime,
        implementation,
        agent: fakePi
          ? // Like a real agent, the fake records and reports each turn it settles, which it does
            // on receipt.
            () => {
              const { turns } = fakePi;
              async function settled(config: PiAgentConfig, requestId: string) {
                const answered = turns.find((call) => call.requestId === requestId);
                const ended = answered
                  ? piAgentTurnCompletedEvent(
                      config,
                      createBackofficeAgentContext({
                        config,
                        runtime,
                        readActiveTurn: async () => answered.turn,
                      }),
                      { requestId, turn: answered.turn },
                      answered.answerEntryId,
                      new Date(nowEpochMs()),
                    )
                  : null;
                if (ended && runtime.config.bindings.automations) {
                  await runtime.objects.automations
                    .for(config.scope)
                    .commands.ingestEvent(ended, { propagationContext: null });
                }
                await runtime.objects.piManager
                  .for(config.scope)
                  .commands.reportSettledTurn({ agentName: config.agentName, requestId, ended });
              }
              return {
                ...fakePi.agent,
                async steer(config, revision, turn, steer) {
                  await fakePi.agent.steer(config, revision, turn, steer);
                  await settled(
                    config,
                    steer.type === "prompt"
                      ? steer.requestId
                      : piNotificationRequestId(steer.notification),
                  );
                },
                async dispatch(config, revision, turn, work) {
                  await fakePi.agent.dispatch(config, revision, turn, work);
                  await settled(config, work.requestId);
                },
              };
            }
          : getPiAgent,
        supportedAvailableModels: fakePi
          ? async () => [
              {
                provider: "openai",
                modelId: "gpt-5.6-luna",
                label: "GPT-5.6 Luna",
                contextWindow: 400_000,
                thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
              },
            ]
          : async () => piAvailableModels ?? [],
        classifier: fakes.openaiDecisions
          ? createPiClassifier(
              { OPENAI_API_KEY: "scenario-openai-api-key" },
              fakes.openaiDecisions.fetch,
            )
          : (fakes.classifier?.classify ?? null),
        imageGenerator: fakes.openaiImages
          ? createPiImageGenerator(
              { OPENAI_API_KEY: "scenario-openai-api-key" },
              fakes.openaiImages.fetch,
            )
          : null,
        extractor: fakes.openaiResponses
          ? createPiExtractor(
              { OPENAI_API_KEY: "scenario-openai-api-key" },
              fakes.openaiResponses.fetch,
            )
          : null,
        workersAi: fakes.workersAi
          ? createPiWorkersAi(fakes.workersAi.binding, fakes.workersAi.fetch)
          : null,
        nowEpochMs,
      });
    };
  }

  if (fakes.resend) {
    overrides.RESEND = () => ({
      queueEmail: (
        input: ResendSendEmailInput,
        options: { idempotencyKey: string; senderName: string | null },
      ) => fakes.resend!.queueEmail(input, options),
      fetch: (request: Request) => fakes.resend!.fetch(request),
      alarm: async () => undefined,
      getAdminConfig: async () => ({ configured: true }),
      resetAdminConfig: async () => ({ configured: false }),
      setAdminConfig: async () => ({ configured: true }),
      getDurableHookQueue: async () => ({
        configured: false,
        hooksEnabled: false,
        namespace: null,
        items: [],
        cursor: undefined,
        hasNextPage: false,
      }),
      getDurableHook: async () => null,
      wakeDurableHooks: async () => {},
    });
  }

  return overrides;
};

const collectDiagnostics = async (ctx: BackofficeScenarioContext): Promise<unknown> => {
  const orgs = ctx.files.listOrgIds();
  const stores: Record<string, unknown> = {};
  const workflows: Record<string, unknown> = {};
  const hooksByOrg: Record<string, unknown> = {};
  const filesByOrg: Record<string, unknown> = {};

  for (const orgId of orgs) {
    try {
      stores[orgId] = await getStore(ctx, orgId).list({ limit: 100 });
    } catch (cause) {
      stores[orgId] = cause instanceof Error ? cause.message : String(cause);
    }

    try {
      const workflow = getWorkflow(ctx, orgId);
      const workflowList = await workflow.listInternalWorkflows?.();
      const workflowNames = workflowList?.workflows.map((entry) => entry.name) ?? [
        "codemode-script",
      ];
      const instances = [];
      for (const workflowName of workflowNames) {
        const response = await workflow.listInternalInstances?.({
          workflowName,
          pageSize: 100,
        });
        for (const instance of response?.instances ?? []) {
          instances.push({
            workflowName,
            instance,
            history: await workflow.getInternalHistory?.({
              workflowName,
              instanceId: instance.id,
            }),
          });
        }
      }
      workflows[orgId] = { workflows: workflowNames, instances };
    } catch (cause) {
      workflows[orgId] = cause instanceof Error ? cause.message : String(cause);
    }

    try {
      const hooks = getHooks(ctx, orgId);
      const scopes = [];
      for (const scope of listHookScopes()) {
        scopes.push({
          id: scope.id,
          queue: await hooks.listHooks({ fragment: scope.id, pageSize: 100 }),
        });
      }
      hooksByOrg[orgId] = scopes;
    } catch (cause) {
      hooksByOrg[orgId] = cause instanceof Error ? cause.message : String(cause);
    }

    try {
      const scenarioFs = ctx.files.forOrg(orgId);
      const execution = createBackofficeSystemExecution({ kind: "org", orgId, jurisdiction: null });
      const state = createRuntimeStateBackend({
        runtime: ctx.runtime.services,
        kernel: new BackofficeKernel(ctx.runtime.services),
        execution,
      });
      filesByOrg[orgId] = {
        scenarioPaths: scenarioFs.getAllPaths(),
        scenarioDiff: await ctx.files.diff(orgId),
        orgPaths: await state.glob("/workspace/**"),
      };
    } catch (cause) {
      filesByOrg[orgId] = cause instanceof Error ? cause.message : String(cause);
    }
  }

  return {
    scenario: ctx.name,
    currentStep: ctx.journal.current,
    journal: ctx.journal.entries,
    vars: ctx.vars,
    store: stores,
    workflows,
    hooks: hooksByOrg,
    files: filesByOrg,
    codemodeRuns: ctx.codemodeRuns.map((run) => ({
      label: run.label,
      scope: run.scope,
      error: run.result.error,
      result: run.result.result,
      toolCalls: run.result.toolCalls,
    })),
    telegram: ctx.fakes.telegram
      ? {
          sendMessageCalls: ctx.fakes.telegram.sendMessageCalls,
          editMessageTextCalls: ctx.fakes.telegram.editMessageTextCalls,
          sendChatActionCalls: ctx.fakes.telegram.sendChatActionCalls,
          setWebhookCalls: ctx.fakes.telegram.setWebhookCalls,
        }
      : null,
    pi: ctx.fakes.pi
      ? {
          provisionedAgents: ctx.fakes.pi.provisionedAgents,
          getViewCalls: ctx.fakes.pi.getViewCalls,
          turns: ctx.fakes.pi.turns,
        }
      : null,
  };
};

const wrapScenarioError = async (
  ctx: BackofficeScenarioContext,
  phase: "setup" | "steps",
  step: BackofficeScenarioStep,
  cause: unknown,
) => {
  const diagnostics = await collectDiagnostics(ctx);
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Backoffice scenario "${ctx.name}" failed during ${phase} step "${step.label}": ${message}\n\n${JSON.stringify(
      diagnostics,
      null,
      2,
    )}`,
  );
  error.cause = cause;
  return error;
};

const runStep = async (
  ctx: BackofficeScenarioContext,
  phase: "setup" | "steps",
  step: BackofficeScenarioStep,
  scenarioDefaultDrain: boolean,
) => {
  ctx.journal.current = { phase, label: step.label, type: step.type };
  try {
    await step.run(ctx);
    if (step.drain ?? scenarioDefaultDrain) {
      await ctx.drain();
    }
    ctx.journal.entries.push({ phase, label: step.label, type: step.type, status: "completed" });
  } catch (cause) {
    ctx.journal.entries.push({ phase, label: step.label, type: step.type, status: "failed" });
    throw await wrapScenarioError(ctx, phase, step, cause);
  } finally {
    ctx.journal.current = undefined;
  }
};

export const runBackofficeScenario = async <TVars extends ScenarioVars = ScenarioVars>(
  scenario: BackofficeScenarioDefinition<TVars>,
): Promise<BackofficeScenarioContext<TVars>> => {
  const orgIds = new Set<string>();
  const files = createScenarioFileSystems(
    scenario.files ?? backofficeFiles.workspaceStarter(),
    orgIds,
  );
  const fakes = scenario.fakes?.({ fake: createScenarioFakeFactory() }) ?? {};
  const kernelActions: BackofficeKernelAction[] = [];
  const kernelObserver: BackofficeKernelObserver = {
    async observeAuthorization(action) {
      kernelActions.push(action);
    },
    async runAction(_action, execute) {
      await execute();
    },
  };
  const telemetry: BackofficeTelemetrySignal[] = [];
  const runtime = await createInMemoryBackofficeRuntime({
    env: scenario.env,
    sqliteDataDirectory: scenario.options?.sqliteDataDirectory,
    createSandboxProviders: scenario.createSandboxProviders,
    kernelObserver,
    telemetry: {
      record(signal) {
        telemetry.push(signal);
      },
    },
    readAutomationSource: async ({ execution, path }) =>
      await (
        execution.scope.kind === "project"
          ? files.forProject(execution.scope.projectId)
          : execution.scope.kind === "user"
            ? files.forUser(execution.scope.userId)
            : files.forOrg(execution.scope.kind === "org" ? execution.scope.orgId : undefined)
      ).readFile(path, "utf-8"),
    objects: { ...scenario.objects, ...(await createFakeObjectOverrides(fakes)) },
    piAvailableModels: scenario.piAvailableModels,
    workersAi: fakes.workersAi !== undefined,
    ...(fakes.web ? { webFetch: fakes.web.fetch } : {}),
    ...(scenario.durableHooks ? { durableHooks: scenario.durableHooks } : {}),
  });
  const journal: ScenarioJournal = { entries: [] };
  const vars = scenario.vars?.() ?? ({} as TVars);
  const lofi = createScenarioLofi(runtime);

  let ctx: BackofficeScenarioContext<TVars>;
  ctx = {
    name: scenario.name,
    runtime,
    files,
    vars,
    fakes,
    lofi,
    codemodeRuns: [],
    kernelActions,
    telemetry,
    journal,
    drain: async () => {
      await runtime.drain();
      await lofi.syncAll();
    },
    runCodemode: (input) => runScenarioCodemode(ctx, input),
    cleanup: async () => {
      try {
        await lofi.cleanup();
      } finally {
        await runtime.cleanup();
      }
    },
    rememberOrg: (orgId) => {
      orgIds.add(orgId);
    },
  };
  const builders = buildStepBuilders<TVars>();
  const scenarioDefaultDrain = scenario.options?.drain ?? true;

  try {
    for (const step of scenario.setup?.(builders) ?? []) {
      await runStep(ctx, "setup", step, scenarioDefaultDrain);
    }
    for (const step of scenario.steps(builders)) {
      await runStep(ctx, "steps", step, scenarioDefaultDrain);
    }
    if (!scenario.options?.allowErroredWorkflows) {
      await runStep(ctx, "steps", builders.then.workflow.noErrored(), scenarioDefaultDrain);
    }
    if (!scenario.options?.allowFailedDurableHooks) {
      await runStep(ctx, "steps", builders.then.hooks.noFailed(), scenarioDefaultDrain);
    }
    return ctx;
  } finally {
    await ctx.cleanup();
  }
};
