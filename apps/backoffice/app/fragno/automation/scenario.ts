import type { TelegramApi, TelegramMessage } from "@fragno-dev/telegram-fragment";

import type { InMemoryObjectFactoryOverrides } from "@/backoffice-runtime/in-memory-object-factory";
import {
  createInMemoryBackofficeRuntime,
  type InMemoryBackofficeRuntime,
} from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type {
  BackofficeObjectAddress,
  BackofficeObjectBindingName,
} from "@/backoffice-runtime/object-registry";
import {
  createBackofficeFileSystem,
  SYSTEM_FILE_CONTENT,
  WORKSPACE_STARTER_CONTENT,
} from "@/files";
import type { MasterFileSystem } from "@/files";
import {
  runBackofficeCodemode,
  type BackofficeCodemodeExecuteResult,
} from "@/fragno/codemode/execute";
import type { TelegramAutomationFileMetadata } from "@/fragno/runtime-tools/families/telegram-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import type { BackofficeRuntimeToolCall } from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { InMemoryTelegramObject } from "../../../workers/telegram.do";
import { listHookScopes } from "../backoffice-capabilities/backoffice-capabilities";
import { createRouteBackedAutomationStoreRuntime } from "./bindings-route-runtime";
import type { AutomationEvent } from "./contracts";
import { createRouteBackedDurableHooksRuntime } from "./durable-hooks-route-runtime";
import { createTestMasterFileSystem } from "./engine/test-master-file-system.test-utils";
import type { AutomationRouteDefinition } from "./routing";
import { createRouteBackedAutomationRouterRuntime } from "./routing-route-runtime";
import type { AutomationRouteCreateInput, AutomationRouteUpdateInput } from "./routing-schemas";
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
  orgId: string;
  code: string;
  label?: string;
  timeout?: number;
  assertToolCalls?: readonly string[];
};

type ScenarioCodemodeRun = {
  label: string;
  orgId: string;
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

type PiSessionStatus = "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";

type FakePiSession = {
  id: string;
  name: string | null;
  status: PiSessionStatus;
  agent: string;
  workflowName: string;
  createdAt: string;
  updatedAt: string;
  assistantText: string;
};

type PiCreateSessionCall = {
  agent: string;
  name: string | null;
  systemMessage?: string;
  sessionId: string;
};

type PiGetSessionCall = {
  sessionId: string;
};

type PiRunTurnCall = {
  sessionId: string;
  text: string;
  assistantText: string;
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

type FakeMcpServer = {
  slug: string;
  name?: string | null;
  endpointUrl?: string;
  authMode?: string;
  cache?: {
    tools?: Array<{
      name: string;
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }> | null;
  } | null;
};

type TelegramAdminApi = NonNullable<
  ConstructorParameters<typeof InMemoryTelegramObject>[0]["adminApi"]
>;

export type FakeTelegramApi = {
  api: TelegramApi;
  adminApi: TelegramAdminApi;
  sendMessageCalls: TelegramSendCall[];
  editMessageTextCalls: TelegramEditCall[];
  sendChatActionCalls: TelegramChatActionCall[];
  getFileCalls: TelegramGetFileCall[];
  downloadFileCalls: TelegramDownloadFileCall[];
  setWebhookCalls: Parameters<TelegramAdminApi["setWebhook"]>[0][];
  setFile(input: FakeTelegramFile): void;
  getFileFixture(fileId: string): FakeTelegramFile | null;
};

export type FakePiApi = {
  createSessionCalls: PiCreateSessionCall[];
  getSessionCalls: PiGetSessionCall[];
  runTurnCalls: PiRunTurnCall[];
  fetch(request: Request): Promise<Response>;
  setSessionStatus(sessionId: string, status: PiSessionStatus): void;
};

export type FakeResendApi = {
  replyCalls: FakeResendReplyCall[];
  fetch(request: Request): Promise<Response>;
};

export type FakeMcpApi = {
  servers: FakeMcpServer[];
  fetch(request: Request): Promise<Response>;
  getAdminConfig(): Promise<{ configured: boolean }>;
  resetAdminConfig(): Promise<{ configured: boolean }>;
  setAdminConfig(): Promise<{ configured: boolean }>;
};

export type ScenarioFakes = {
  telegram?: FakeTelegramApi;
  pi?: FakePiApi;
  resend?: FakeResendApi;
  mcp?: FakeMcpApi;
};

type ScenarioFakeFactory = {
  telegram(input?: { files?: FakeTelegramFile[] }): FakeTelegramApi;
  pi(input?: { assistantText?: (input: { sessionId: string; text: string }) => string }): FakePiApi;
  resend(input?: { threads?: FakeResendThreadSeed[] }): FakeResendApi;
  mcp(input?: { servers?: FakeMcpServer[] }): FakeMcpApi;
};

type FileDiffStatus = "added" | "changed" | "removed";

type FileDiffEntry = {
  path: string;
  status: FileDiffStatus;
  before?: string;
  after?: string;
};

type BackofficeScenarioFilePreset = {
  createFileSystem(): MasterFileSystem;
  snapshot: Record<string, string>;
};

export type BackofficeScenarioFileSystems = {
  forOrg(orgId?: string): MasterFileSystem;
  forProject(projectId: string): MasterFileSystem;
  listOrgIds(): string[];
  diff(orgId?: string): Promise<FileDiffEntry[]>;
};

export type BackofficeScenarioContext<TVars extends ScenarioVars = ScenarioVars> = {
  name: string;
  runtime: InMemoryBackofficeRuntime;
  files: BackofficeScenarioFileSystems;
  vars: TVars;
  fakes: ScenarioFakes;
  codemodeRuns: ScenarioCodemodeRun[];
  journal: ScenarioJournal;
  drain(): Promise<void>;
  runCodemode(input: BackofficeScenarioCodemodeInput): Promise<BackofficeCodemodeExecuteResult>;
  cleanup(): Promise<void>;
  rememberOrg(orgId: string): void;
};

export type BackofficeScenarioDefinitionInput<TVars extends ScenarioVars = ScenarioVars> = {
  name: string;
  files?: BackofficeScenarioFilePreset;
  vars?: () => TVars;
  fakes?: (ctx: { fake: ScenarioFakeFactory }) => ScenarioFakes;
  setup?: (builders: BackofficeScenarioStepBuilders<TVars>) => BackofficeScenarioStep[];
  steps: (builders: BackofficeScenarioStepBuilders<TVars>) => BackofficeScenarioStep[];
  options?: {
    drain?: boolean;
    allowErroredWorkflows?: boolean;
    allowFailedDurableHooks?: boolean;
  };
};

export type BackofficeScenarioDefinition<TVars extends ScenarioVars = ScenarioVars> =
  BackofficeScenarioDefinitionInput<TVars>;

type OrganizationExistsInput = {
  id: string;
  name?: string;
  ownerUserId?: string;
};

type TelegramConfiguredInput = {
  orgId: string;
  botUsername: string;
  botToken?: string;
  webhookSecretToken?: string;
  apiBaseUrl?: string;
  webhookBaseUrl?: string;
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

type PiCreatedSessionInput = {
  agent?: string;
  name?: string | null;
  sessionId?: string;
};

type PiRanTurnInput = {
  sessionId?: string;
  text?: string;
  assistantText?: string | RegExp;
};

type ResendRepliedToThreadInput = {
  threadId?: string;
  body?: string | RegExp;
};

type StoreEntryInput = {
  orgId: string;
  key: string;
  value: string;
};

type StoreEntriesInput = {
  orgId: string;
  prefix?: string;
  include: Array<string | { key: string; value?: string }>;
};

type PiDefaultAgentInput = {
  orgId: string;
  value: string;
};

type ConnectionConfiguredInput = {
  orgId: string;
  id: string;
  payload?: unknown;
};

type ProjectCreateInput = {
  orgId: string;
  slug?: string;
  name: string;
  description?: string | null;
  createdByUserId: string;
  captureIdAs?: string;
  label?: string;
};

type CodemodeStoreSetInput = StoreEntryInput & {
  actor?: unknown;
};

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

type WorkflowInstanceInput = {
  workflowName?: string;
  instanceId?: string;
  remoteWorkflowName?: string;
  status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
  waitingFor?: string;
  output?: unknown;
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

type WorkflowCreateInstanceInput<TVars extends ScenarioVars = ScenarioVars> = {
  orgId: string;
  workflowName?: string;
  remoteWorkflowName?: string;
  instanceId: string;
  params: ScenarioValue<TVars, Record<string, unknown>>;
  label?: string;
};

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

type PiCapabilityConfiguredInput = {
  orgId: string;
  harnessId?: string;
  harnessLabel?: string;
  harnessTools?: string[];
  modelProvider?: string;
  modelName?: string;
  modelLabel?: string;
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
    organization: {
      exists(input: OrganizationExistsInput): BackofficeScenarioStep;
    };
    telegram: {
      configured(input: TelegramConfiguredInput): BackofficeScenarioStep;
    };
    pi: {
      defaultAgent(input: PiDefaultAgentInput): BackofficeScenarioStep;
    };
    store: {
      entry(input: StoreEntryInput): BackofficeScenarioStep;
    };
    router: {
      route(input: RouterCreateRouteInput): BackofficeScenarioStep;
    };
    connection: {
      configured(input: ConnectionConfiguredInput): BackofficeScenarioStep;
    };
    files(input: FilesSetupInput): BackofficeScenarioStep;
    codemode: {
      run(input: BackofficeScenarioCodemodeInput): BackofficeScenarioStep;
      storeSet(input: CodemodeStoreSetInput): BackofficeScenarioStep;
      connectionConfigure(input: ConnectionConfiguredInput): BackofficeScenarioStep;
      writeFile(input: CodemodeWriteFileInput): BackofficeScenarioStep;
    };
    direct: {
      storeEntry(input: StoreEntryInput): BackofficeScenarioStep;
      file(input: FileAssertionInput & { content: string | Uint8Array }): BackofficeScenarioStep;
    };
  };
  when: {
    auth: {
      organizationCreated(input: OrganizationCreatedInput): BackofficeScenarioStep;
    };
    capability: {
      configured: ((input: CapabilityConfiguredInput) => BackofficeScenarioStep) & {
        pi(input: PiCapabilityConfiguredInput): BackofficeScenarioStep;
      };
    };
    automation: {
      ingestEvent(input: AutomationEvent): BackofficeScenarioStep;
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
    telegram: {
      sentMessage(input: TelegramSentMessageInput): BackofficeScenarioStep;
      noMessages(): BackofficeScenarioStep;
      sentChatAction(input: TelegramSentChatActionInput): BackofficeScenarioStep;
    };
    pi: {
      createdSession(input: PiCreatedSessionInput): BackofficeScenarioStep;
      ranTurn(input: PiRanTurnInput): BackofficeScenarioStep;
    };
    resend: {
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
    connection: {
      configured(input: Omit<ConnectionConfiguredInput, "payload">): BackofficeScenarioStep;
      unconfigured(input: Omit<ConnectionConfiguredInput, "payload">): BackofficeScenarioStep;
    };
    codemode: {
      toolCalls(input: CodemodeToolCallsInput): BackofficeScenarioStep;
    };
    files: {
      exists(input: FileAssertionInput): BackofficeScenarioStep;
      missing(input: FileAssertionInput): BackofficeScenarioStep;
      contains(input: FileContainsInput): BackofficeScenarioStep;
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
  };
};

const mapContentToMountedFiles = (
  mountPoint: "/system" | "/workspace",
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
  createFileSystem: () => createTestMasterFileSystem(files),
  snapshot: Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      path,
      typeof content === "string" ? content : `[binary:${content.byteLength}]`,
    ]),
  ),
});

export const backofficeFiles = {
  systemOnly: () => createPreset(mapContentToMountedFiles("/system", SYSTEM_FILE_CONTENT)),
  workspaceStarter: () =>
    createPreset(mapContentToMountedFiles("/workspace", WORKSPACE_STARTER_CONTENT)),
  fullStarter: () =>
    createPreset({
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
    setFile,
    getFileFixture: (fileId) => filesById.get(fileId) ?? null,
    adminApi: {
      setWebhook: async (input) => {
        setWebhookCalls.push(input);
        return { ok: true, message: "webhook set" };
      },
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

const createNdjsonResponse = (items: unknown[]) =>
  new Response(items.map((item) => JSON.stringify(item)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });

const createFakePiApi = (
  options: {
    assistantText?: (input: { sessionId: string; text: string }) => string;
  } = {},
): FakePiApi => {
  const createSessionCalls: PiCreateSessionCall[] = [];
  const getSessionCalls: PiGetSessionCall[] = [];
  const runTurnCalls: PiRunTurnCall[] = [];
  const sessions = new Map<string, FakePiSession>();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const assistantText =
    options.assistantText ?? ((input: { text: string }) => `agent:${input.text}`);

  const toSessionDetail = (session: FakePiSession) => ({
    id: session.id,
    name: session.name,
    status: session.status,
    agentName: session.agent,
    workflowName: session.workflowName,
    workflow: { status: session.status },
    agent: {
      state: {
        messages: session.assistantText
          ? [
              {
                role: "assistant",
                content: [{ type: "text", text: session.assistantText }],
              },
            ]
          : [],
      },
      events: [],
    },
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });

  const getSessionOrResponse = (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return Response.json(
        { message: `Session ${sessionId} not found.`, code: "SESSION_NOT_FOUND" },
        { status: 404 },
      );
    }
    return session;
  };

  return {
    createSessionCalls,
    getSessionCalls,
    runTurnCalls,
    setSessionStatus: (sessionId, status) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`Fake Pi session not found: ${sessionId}`);
      }
      session.status = status;
      session.updatedAt = new Date().toISOString();
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const sessionMatch = pathname.match(
        /\/api\/pi\/workflows\/([^/]+)\/sessions(?:\/([^/]+))?(?:\/([^/]+))?$/u,
      );
      const workflowName = sessionMatch?.[1] ?? "interactive-chat-workflow";
      const sessionId = sessionMatch?.[2] ?? "";
      const suffix = sessionMatch?.[3] ?? "";

      if (request.method === "POST" && pathname === `/api/pi/workflows/${workflowName}/sessions`) {
        const body = (await request.json()) as {
          name?: string | null;
          input?: { agentName?: string; systemPrompt?: string };
        };
        const id = `pi-session-${sessions.size + 1}`;
        const agent = body.input?.agentName ?? "default::openai::gpt-5-mini";
        const session: FakePiSession = {
          id,
          name: body.name ?? null,
          status: "waiting",
          agent,
          workflowName,
          assistantText: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        sessions.set(id, session);
        createSessionCalls.push({
          agent,
          name: session.name,
          sessionId: id,
          ...(body.input?.systemPrompt ? { systemMessage: body.input.systemPrompt } : {}),
        });
        return Response.json(session);
      }

      if (request.method === "GET" && pathname === `/api/pi/workflows/${workflowName}/sessions`) {
        return Response.json([...sessions.values()]);
      }

      if (!sessionId) {
        return Response.json({ message: "Not found", code: "NOT_FOUND" }, { status: 404 });
      }

      if (request.method === "GET" && !suffix) {
        getSessionCalls.push({ sessionId });
      }

      const session = getSessionOrResponse(sessionId);
      if (session instanceof Response) {
        return session;
      }

      if (request.method === "GET" && suffix === "events") {
        return createNdjsonResponse([
          { type: "snapshot", state: { messages: [] } },
          { type: "turn_end" },
        ]);
      }

      if (request.method === "POST" && suffix === "command") {
        const body = (await request.json()) as { input?: { text?: string } };
        const text = body.input?.text ?? "";
        const reply = assistantText({ sessionId, text });
        session.assistantText = reply;
        session.status = "waiting";
        session.updatedAt = new Date().toISOString();
        runTurnCalls.push({ sessionId, text, assistantText: reply });
        return Response.json({
          accepted: true,
          commandId: `command-${runTurnCalls.length}`,
          status: "active",
        });
      }

      if (request.method === "GET" && !suffix) {
        return Response.json(toSessionDetail(session));
      }

      return Response.json({ message: "Not found", code: "NOT_FOUND" }, { status: 404 });
    },
  };
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
  const lastText = String(lastMessage?.text ?? "");

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
    fetch: async (request) => {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const threadMatch = pathname.match(/\/api\/resend\/threads\/([^/]+)(?:\/([^/]+))?$/u);
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

const createScenarioFakeFactory = (): ScenarioFakeFactory => ({
  telegram: createFakeTelegramApi,
  pi: createFakePiApi,
  resend: createFakeResendApi,
  mcp: createFakeMcpApi,
});

const createFakeMcpApi = (input: { servers?: FakeMcpServer[] } = {}): FakeMcpApi => {
  let configured = false;
  const servers = input.servers ?? [];

  const normalizeServer = (server: FakeMcpServer) => ({
    endpointUrl: "https://example.com/mcp",
    authMode: "none",
    ...server,
  });

  return {
    servers,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/servers")) {
        if (!configured) {
          return Response.json(
            { message: "MCP is not configured for this organisation." },
            { status: 400 },
          );
        }
        return Response.json({ servers: servers.map(normalizeServer) });
      }
      return Response.json({ message: "Not found", code: "NOT_FOUND" }, { status: 404 });
    },
    getAdminConfig: async () => ({ configured }),
    resetAdminConfig: async () => {
      configured = false;
      return { configured };
    },
    setAdminConfig: async () => {
      configured = true;
      return { configured };
    },
  };
};

const readSnapshotContent = async (fs: MasterFileSystem, path: string): Promise<string | null> => {
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

const snapshotFileSystem = async (fs: MasterFileSystem): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  for (const path of fs.getAllPaths()) {
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
  const byOrg = new Map<string, MasterFileSystem>();
  const byProject = new Map<string, MasterFileSystem>();

  const getScopedFs = (map: Map<string, MasterFileSystem>, key: string) => {
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
    listOrgIds: () => Array.from(orgIds),
    diff: async (orgId = "__default__") =>
      diffSnapshots(preset.snapshot, await snapshotFileSystem(forOrg(orgId))),
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

const getStore = (ctx: BackofficeScenarioContext, orgId: string) =>
  createRouteBackedAutomationStoreRuntime({
    object: ctx.runtime.objects.automations.forOrg(orgId),
    scope: { kind: "org", orgId },
  });

const SYSTEM_WORKFLOW_TARGET_ID = "__system__";

const getWorkflow = (ctx: BackofficeScenarioContext, orgId: string) =>
  orgId === SYSTEM_WORKFLOW_TARGET_ID
    ? createRouteBackedAutomationWorkflowRuntime({
        object: ctx.runtime.objects.automations.singleton(),
        scope: { kind: "system" },
      })
    : createRouteBackedAutomationWorkflowRuntime({
        object: ctx.runtime.objects.automations.forOrg(orgId),
        scope: { kind: "org", orgId },
      });

const getRouter = (ctx: BackofficeScenarioContext, orgId: string) =>
  createRouteBackedAutomationRouterRuntime({
    object: ctx.runtime.objects.automations.forOrg(orgId),
    scope: { kind: "org", orgId },
  });

const getHooks = (ctx: BackofficeScenarioContext, orgId: string) =>
  createRouteBackedDurableHooksRuntime({
    objects: ctx.runtime.objects,
    config: ctx.runtime.config,
    orgId,
  });

const hookFragmentBindings: Record<string, BackofficeObjectBindingName> = {
  auth: "AUTH",
  automations: "AUTOMATIONS",
  cloudflare: "CLOUDFLARE_WORKERS",
  github: "GITHUB",
  mcp: "MCP",
  otp: "OTP",
  pi: "PI",
  "pi-workflows": "PI",
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

  return { binding, scope: { kind: "org", orgId } };
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

const fileExists = async (fs: MasterFileSystem, path: string): Promise<boolean> => {
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
): Promise<MasterFileSystem | null> => {
  const scenarioFs = ctx.files.forOrg(orgId);
  if (await fileExists(scenarioFs, path)) {
    return scenarioFs;
  }

  const orgFs = await createBackofficeFileSystem({
    objects: ctx.runtime.objects,
    kernel: new BackofficeKernel({ objects: ctx.runtime.objects }),
    execution: { actor: createScenarioActor(orgId), scope: { kind: "org", orgId } },
  });
  if (await fileExists(orgFs, path)) {
    return orgFs;
  }

  return null;
};

const createScenarioActor = (orgId: string) => ({
  type: "user" as const,
  id: "scenario-user",
  userId: "scenario-user",
  organizationIds: [orgId],
});

const getConnectionRuntime = (ctx: BackofficeScenarioContext, orgId: string) =>
  createBackofficeToolContext(
    createRouteBackedRuntimeContext({
      runtime: ctx.runtime.services,
      kernel: new BackofficeKernel({ objects: ctx.runtime.services.objects }),
      execution: { actor: createScenarioActor(orgId), scope: { kind: "org", orgId } },
    }),
  ).runtimes.backoffice;

const formatToolCallName = (call: BackofficeRuntimeToolCall) =>
  `${call.providerName}.${call.toolName}`;

const matchesToolCall = (call: BackofficeRuntimeToolCall, expected: string) =>
  call.toolId === expected || formatToolCallName(call) === expected;

const parseScenarioDurationMs = (duration: TimeAdvanceInput): number => {
  if (typeof duration === "number") {
    return duration;
  }

  const trimmed = duration.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(\w+)?$/iu);
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
  ctx.rememberOrg(input.orgId);

  const runtimeContext = createRouteBackedRuntimeContext({
    runtime: ctx.runtime.services,
    kernel: new BackofficeKernel({ objects: ctx.runtime.services.objects }),
    execution: {
      actor: createScenarioActor(input.orgId),
      scope: { kind: "org", orgId: input.orgId },
    },
  });
  const toolContext = createBackofficeToolContext(runtimeContext);
  const loader = ctx.runtime.env.LOADER;
  if (!loader) {
    throw new Error("Backoffice scenario codemode requires a Worker Loader.");
  }
  const result = await runBackofficeCodemode({
    code: input.code,
    fs: ctx.files.forOrg(input.orgId),
    env: { LOADER: loader },
    timeout: input.timeout,
    families: runtimeToolFamilies,
    toolContext: toolContext,
  });

  ctx.codemodeRuns.push({
    label: input.label ?? "run codemode",
    orgId: input.orgId,
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
    : typeof event.subject?.orgId === "string"
      ? event.subject.orgId
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
  await systemAutomations.seedStarterAutomationRoutes();
  await systemAutomations.ingestEvent({ ...event, scope: { kind: "system" } });
};

const ingestAutomationEvent = async (ctx: BackofficeScenarioContext, event: AutomationEvent) => {
  if (event.scope.kind === "system" || event.source === "auth") {
    await ingestSystemAutomationEvent(ctx, event);
    return;
  }

  if (event.scope.kind !== "org") {
    throw new Error("Automation scenario events require an organisation scope.");
  }

  ctx.rememberOrg(event.scope.orgId);
  if (isSystemRoutedAutomationEvent(event)) {
    const systemAutomations = ctx.runtime.objects.automations.singleton();
    await systemAutomations.seedStarterAutomationRoutes();
    await systemAutomations.ingestEvent({ ...event, id: `system:${event.id}` });
  }
  await ctx.runtime.objects.automations.forOrg(event.scope.orgId).ingestEvent(event);
};

const buildOrganizationCreatedEvent = (input: OrganizationCreatedInput): AutomationEvent => {
  const now = "2026-01-01T00:00:00.000Z";
  const ownerUserId = input.ownerUserId ?? "user-1";
  const ownerEmail = input.ownerEmail ?? "ada@example.com";

  return {
    id: input.eventId ?? `auth:organization.created:${input.id}`,
    scope: { kind: "org", orgId: input.id },
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
    actor: {
      scope: "internal",
      type: "user",
      id: ownerUserId,
      email: ownerEmail,
      role: "user",
    },
    actors: [
      {
        scope: "internal",
        type: "user",
        id: ownerUserId,
        email: ownerEmail,
        role: "user",
      },
    ],
    subject: { orgId: input.id },
  };
};

const buildCapabilityConfiguredEvent = (input: CapabilityConfiguredInput): AutomationEvent => ({
  id: input.eventId ?? `${input.source ?? input.capabilityId}:capability.configured:${input.orgId}`,
  scope: { kind: "org", orgId: input.orgId },
  source: input.source ?? input.capabilityId,
  eventType: "capability.configured",
  occurredAt: "2026-01-01T00:00:00.000Z",
  payload: {
    capabilityId: input.capabilityId,
    capabilityLabel: input.capabilityLabel ?? input.capabilityId,
    ...input.payload,
  },
  actor: {
    scope: "internal",
    type: "capability",
    id: input.capabilityId,
    role: "system",
  },
  actors: [
    {
      scope: "internal",
      type: "capability",
      id: input.capabilityId,
      role: "system",
    },
  ],
  subject: { orgId: input.orgId, capabilityId: input.capabilityId },
});

const buildPiCapabilityConfiguredEvent = (input: PiCapabilityConfiguredInput): AutomationEvent =>
  buildCapabilityConfiguredEvent({
    orgId: input.orgId,
    source: "pi",
    capabilityId: "pi",
    capabilityLabel: "Pi",
    eventId: input.eventId ?? `pi:capability.configured:${input.orgId}`,
    payload: {
      harnesses: [
        {
          id: input.harnessId ?? "default",
          label: input.harnessLabel ?? "Default",
        },
      ],
      modelCatalog: [
        {
          provider: input.modelProvider ?? "openai",
          name: input.modelName ?? "gpt-5-mini",
          label: input.modelLabel ?? "GPT-5 mini",
        },
      ],
    },
  });

const buildIdentityClaimCompletedEvent = (input: ConfirmClaimInput): AutomationEvent => {
  const actor = {
    scope: "external" as const,
    source: input.actor?.source ?? "telegram",
    type: input.actor?.type ?? "chat",
    id: input.actor?.id ?? "unknown",
  };

  return {
    id: input.eventId ?? `identity-claim-completed:${input.otpId}`,
    scope: { kind: "org", orgId: input.orgId },
    source: "otp",
    eventType: "identity.claim.completed",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      otpId: input.otpId,
      claimType: input.claimType ?? "identity_link",
    },
    actor,
    actors: [actor],
    subject: {
      userId: input.subjectUserId,
    },
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
  const response = await ctx.runtime.objects.telegram.forOrg(orgId).fetch(
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
  ctx: BackofficeScenarioContext<TVars>,
  value: ScenarioValue<TVars, TValue>,
): Promise<TValue> =>
  typeof value === "function"
    ? await (value as (ctx: BackofficeScenarioContext<TVars>) => Promise<TValue> | TValue)(ctx)
    : value;

const scenarioIdString = (id: unknown): string =>
  typeof id === "object" && id && "externalId" in id ? String(id.externalId) : String(id);

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
  const workflowName = input.workflowName ?? "automation-codemode-script";
  const matches: ScenarioWorkflowInstance[] = [];

  for (const orgId of orgIds) {
    const workflow = getWorkflow(ctx, orgId);
    if (input.instanceId && workflow.getInstance) {
      try {
        const instance = await workflow.getInstance({
          workflowName,
          instanceId: input.instanceId,
        });
        matches.push({ orgId, workflowName, instance });
      } catch {
        // Keep looking across known orgs.
      }
      continue;
    }

    const response = await workflow.listInstances?.({
      workflowName,
      remoteWorkflowName: input.remoteWorkflowName,
      pageSize: 100,
    });
    for (const summary of response?.instances ?? []) {
      const instance = workflow.getInstance
        ? await workflow.getInstance({ workflowName, instanceId: summary.id })
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
    organization: {
      exists: (input) =>
        createStep(
          "given",
          "organization.exists",
          `setup organization ${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.id);
            ctx.vars[`organization:${input.id}`] = {
              id: input.id,
              name: input.name,
              ownerUserId: input.ownerUserId,
            };
            await ctx.runtime.objects.automations.forOrg(input.id).seedStarterAutomationRoutes();
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
            const webhookBaseUrl = input.webhookBaseUrl ?? "https://example.com";
            await ctx.runtime.objects.telegram.forOrg(input.orgId).setAdminConfig(
              {
                orgId: input.orgId,
                botToken: input.botToken ?? "123456:telegram-bot-token",
                webhookSecretToken,
                botUsername: input.botUsername,
                apiBaseUrl: input.apiBaseUrl ?? "https://telegram.test",
                webhookBaseUrl,
              },
              webhookBaseUrl,
            );
            ctx.vars[`telegram:${input.orgId}:webhookSecretToken`] = webhookSecretToken;
          },
        ),
    },
    pi: {
      defaultAgent: (input) =>
        createStep(
          "given",
          "pi.defaultAgent",
          `setup Pi default agent for ${input.orgId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await getStore(ctx, input.orgId).set({
              key: "pi/pi-default-agent",
              value: input.value,
              actor: null,
              description: "Default Pi agent for automation-created sessions.",
              category: ["pi"],
            });
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
              actor: null,
            });
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
    connection: {
      configured: (input) =>
        createStep(
          "given",
          "connection.configured",
          `setup connection ${input.orgId}:${input.id}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const runtime = getConnectionRuntime(ctx, input.orgId);
            if (!runtime) {
              throw new Error("Backoffice connection runtime is not available.");
            }
            await runtime.configureConnection({
              id: input.id,
              payload: input.payload ?? {},
            });
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
          input.label ?? `setup codemode for ${input.orgId}`,
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
              orgId: input.orgId,
              label: `set store ${input.key}`,
              code: `async () => {
  await store.set(${JSON.stringify({
    key: input.key,
    value: input.value,
    actor: input.actor ?? null,
  })});
}`,
              assertToolCalls: ["store.set"],
            });
          },
        ),
      connectionConfigure: (input) =>
        createStep(
          "given",
          "codemode.connectionConfigure",
          `setup connection ${input.orgId}:${input.id} through codemode`,
          async (ctx) => {
            await ctx.runCodemode({
              orgId: input.orgId,
              label: `configure connection ${input.id}`,
              code: `async () => {
  await connections.configure(${JSON.stringify({
    id: input.id,
    payload: input.payload ?? {},
  })});
}`,
              assertToolCalls: ["connections.configure"],
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
              orgId: input.orgId,
              label: `write file ${input.path}`,
              code:
                input.content instanceof Uint8Array
                  ? `async () => {
  await state.writeFileBytes(${JSON.stringify(input.path)}, new Uint8Array(${JSON.stringify([
    ...input.content,
  ])}));
}`
                  : `async () => {
  await state.writeFile(${JSON.stringify(input.path)}, ${JSON.stringify(input.content)});
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
              actor: null,
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
      organizationCreated: (input) =>
        createStep(
          "when",
          "auth.organizationCreated",
          `ingest auth organization.created for ${input.id}`,
          (ctx) => ingestAutomationEvent(ctx, buildOrganizationCreatedEvent(input)),
        ),
    },
    capability: {
      configured: Object.assign(
        (input: CapabilityConfiguredInput) =>
          createStep(
            "when",
            "capability.configured",
            `ingest ${input.capabilityId} capability.configured for ${input.orgId}`,
            (ctx) => ingestAutomationEvent(ctx, buildCapabilityConfiguredEvent(input)),
          ),
        {
          pi: (input: PiCapabilityConfiguredInput) =>
            createStep(
              "when",
              "capability.configured.pi",
              `ingest Pi capability.configured for ${input.orgId}`,
              (ctx) => ingestAutomationEvent(ctx, buildPiCapabilityConfiguredEvent(input)),
            ),
        },
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
    router: {
      seedStarter: (input) =>
        createStep(
          "when",
          "router.seedStarter",
          `seed starter routes for ${input.orgId}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            await ctx.runtime.objects.automations.forOrg(input.orgId).seedStarterAutomationRoutes();
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
          input.label ?? `create project ${input.orgId}:${input.slug ?? input.name}`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const response = await ctx.runtime.objects.automations.forOrg(input.orgId).fetch(
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
          input.label ?? `run codemode for ${input.orgId}`,
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
            await getWorkflow(ctx, input.orgId).createInstance({
              workflowName: input.workflowName ?? "automation-codemode-script",
              remoteWorkflowName: input.remoteWorkflowName,
              instanceId: input.instanceId,
              params: await resolveScenarioValue(
                ctx as BackofficeScenarioContext<TVars>,
                input.params,
              ),
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
            await getWorkflow(ctx, input.orgId).sendEvent({
              workflowName: input.workflowName ?? "automation-codemode-script",
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
            const orgId = url.pathname.match(
              /\/backoffice\/automations\/([^/]+)\/claims\/complete/u,
            )?.[1];
            const externalId = url.searchParams.get("externalId");
            const code = url.searchParams.get("code");
            if (!orgId || !externalId || !code) {
              throw new Error(`Captured URL is not a Backoffice claim completion URL: ${captured}`);
            }

            ctx.rememberOrg(orgId);
            const result = await ctx.runtime.objects.otp.forOrg(orgId).confirmIdentityClaim({
              externalId,
              code,
              subjectUserId: input.subjectUserId,
            });
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
      createdSession: (input) =>
        createStep(
          "then",
          "pi.createdSession",
          "assert Pi session was created",
          (ctx) => {
            const calls = ctx.fakes.pi?.createSessionCalls ?? [];
            const call = calls.find(
              (candidate) =>
                (!input.agent || candidate.agent === input.agent) &&
                (typeof input.name === "undefined" || candidate.name === input.name) &&
                (!input.sessionId || candidate.sessionId === input.sessionId),
            );
            if (!call) {
              throw new Error(
                `Expected Pi createSession call was not found. Calls: ${JSON.stringify(
                  calls,
                  null,
                  2,
                )}`,
              );
            }
          },
          { drain: false },
        ),
      ranTurn: (input) =>
        createStep(
          "then",
          "pi.ranTurn",
          "assert Pi turn was run",
          (ctx) => {
            const calls = ctx.fakes.pi?.runTurnCalls ?? [];
            const call = calls.find((candidate) => {
              const assistantOk =
                typeof input.assistantText === "undefined"
                  ? true
                  : typeof input.assistantText === "string"
                    ? candidate.assistantText === input.assistantText
                    : input.assistantText.test(candidate.assistantText);
              return (
                (!input.sessionId || candidate.sessionId === input.sessionId) &&
                (!input.text || candidate.text === input.text) &&
                assistantOk
              );
            });
            if (!call) {
              throw new Error(
                `Expected Pi runTurn call was not found. Calls: ${JSON.stringify(calls, null, 2)}`,
              );
            }
          },
          { drain: false },
        ),
    },
    resend: {
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

            if (typeof input.output !== "undefined") {
              assertPartialMatch(match.instance.details.output, input.output, "workflow.output");
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
              const history = await getWorkflow(ctx, match.orgId).getHistory?.({
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
              const history = await getWorkflow(ctx, match.orgId).getHistory?.({
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
            const workflowList = await workflow.listWorkflows?.();
            for (const entry of workflowList?.workflows ?? [
              { name: "automation-codemode-script" },
            ]) {
              const response = await workflow.listInstances?.({
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
    connection: {
      configured: (input) =>
        createStep(
          "then",
          "connection.configured",
          `assert connection ${input.orgId}:${input.id} is configured`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const runtime = getConnectionRuntime(ctx, input.orgId);
            if (!runtime) {
              throw new Error("Backoffice connection runtime is not available.");
            }
            const status = await runtime.getConnection({ id: input.id });
            if (!status.configured) {
              throw new Error(
                `Expected connection ${input.id} to be configured: ${JSON.stringify(status)}`,
              );
            }
          },
        ),
      unconfigured: (input) =>
        createStep(
          "then",
          "connection.unconfigured",
          `assert connection ${input.orgId}:${input.id} is unconfigured`,
          async (ctx) => {
            ctx.rememberOrg(input.orgId);
            const runtime = getConnectionRuntime(ctx, input.orgId);
            if (!runtime) {
              throw new Error("Backoffice connection runtime is not available.");
            }
            const status = await runtime.getConnection({ id: input.id });
            if (status.configured) {
              throw new Error(
                `Expected connection ${input.id} to be unconfigured: ${JSON.stringify(status)}`,
              );
            }
          },
        ),
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
          const diff = await ctx.files.diff(input.orgId);
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
  },
});

const fakeTelegramFile = (fakeTelegram: FakeTelegramApi, fileId: string): FakeTelegramFile => {
  const file = fakeTelegram.getFileFixture(fileId);
  if (!file) {
    throw new Error(`Fake Telegram file not found: ${fileId}`);
  }
  return file;
};

const createObjectFactories = (fakes: ScenarioFakes): InMemoryObjectFactoryOverrides => {
  const objectFactories: InMemoryObjectFactoryOverrides = {};

  if (fakes.telegram) {
    objectFactories.TELEGRAM = ({ state, runtime }) => {
      const fakeTelegram = fakes.telegram!;
      return new (class extends InMemoryTelegramObject {
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

        async downloadAutomationFile(input: { fileId: string }): Promise<Response> {
          fakeTelegram.downloadFileCalls.push({ fileId: input.fileId });
          const file = fakeTelegramFile(fakeTelegram, input.fileId);
          return new Response(file.bytes.slice(), {
            headers: file.contentType ? { "content-type": file.contentType } : undefined,
          });
        }
      })({
        state,
        runtime,
        api: fakeTelegram.api,
        adminApi: fakeTelegram.adminApi,
      });
    };
  }

  if (fakes.pi) {
    objectFactories.PI = () => ({
      fetch: (request: Request) => fakes.pi!.fetch(request),
      alarm: async () => undefined,
      getAdminConfig: async () => ({ configured: true }),
      resetAdminConfig: async () => ({ configured: false }),
      setAdminConfig: async () => ({ configured: true }),
      getDurableHookRepository: () => ({
        getHookQueue: async () => ({
          configured: false,
          hooksEnabled: false,
          namespace: null,
          items: [],
          cursor: undefined,
          hasNextPage: false,
        }),
        getHook: async () => null,
      }),
    });
  }

  if (fakes.resend) {
    objectFactories.RESEND = () => ({
      fetch: (request: Request) => fakes.resend!.fetch(request),
      alarm: async () => undefined,
      getAdminConfig: async () => ({ configured: true }),
      resetAdminConfig: async () => ({ configured: false }),
      setAdminConfig: async () => ({ configured: true }),
      getDurableHookRepository: () => ({
        getHookQueue: async () => ({
          configured: false,
          hooksEnabled: false,
          namespace: null,
          items: [],
          cursor: undefined,
          hasNextPage: false,
        }),
        getHook: async () => null,
      }),
    });
  }

  if (fakes.mcp) {
    objectFactories.MCP = () => ({
      fetch: (request: Request) => fakes.mcp!.fetch(request),
      alarm: async () => undefined,
      getAdminConfig: () => fakes.mcp!.getAdminConfig(),
      resetAdminConfig: () => fakes.mcp!.resetAdminConfig(),
      setAdminConfig: () => fakes.mcp!.setAdminConfig(),
      getDurableHookRepository: () => ({
        getHookQueue: async () => ({
          configured: false,
          hooksEnabled: false,
          namespace: null,
          items: [],
          cursor: undefined,
          hasNextPage: false,
        }),
        getHook: async () => null,
      }),
    });
  }

  return objectFactories;
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
      const workflowList = await workflow.listWorkflows?.();
      const workflowNames = workflowList?.workflows.map((entry) => entry.name) ?? [
        "automation-codemode-script",
      ];
      const instances = [];
      for (const workflowName of workflowNames) {
        const response = await workflow.listInstances?.({
          workflowName,
          pageSize: 100,
        });
        for (const instance of response?.instances ?? []) {
          instances.push({
            workflowName,
            instance,
            history: await workflow.getHistory?.({
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
      const orgFs = await createBackofficeFileSystem({
        objects: ctx.runtime.objects,
        kernel: new BackofficeKernel({ objects: ctx.runtime.objects }),
        execution: { actor: createScenarioActor(orgId), scope: { kind: "org", orgId } },
      });
      filesByOrg[orgId] = {
        scenarioPaths: scenarioFs.getAllPaths(),
        scenarioDiff: await ctx.files.diff(orgId),
        orgPaths: orgFs.getAllPaths(),
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
      orgId: run.orgId,
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
          createSessionCalls: ctx.fakes.pi.createSessionCalls,
          getSessionCalls: ctx.fakes.pi.getSessionCalls,
          runTurnCalls: ctx.fakes.pi.runTurnCalls,
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
  const runtime = await createInMemoryBackofficeRuntime({
    getAutomationFileSystem: async ({ execution }) =>
      execution.scope.kind === "project"
        ? files.forProject(execution.scope.projectId)
        : files.forOrg(execution.scope.kind === "org" ? execution.scope.orgId : undefined),
    objectFactories: createObjectFactories(fakes),
  });
  const journal: ScenarioJournal = { entries: [] };
  const vars = scenario.vars?.() ?? ({} as TVars);

  let ctx: BackofficeScenarioContext<TVars>;
  ctx = {
    name: scenario.name,
    runtime,
    files,
    vars,
    fakes,
    codemodeRuns: [],
    journal,
    drain: () => runtime.drain(),
    runCodemode: (input) => runScenarioCodemode(ctx, input),
    cleanup: () => runtime.cleanup(),
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
