import { describe, expect, test, assert } from "vitest";

import { backofficeCapabilities } from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import {
  CODEMODE_STATE_DTS_PATH,
  CODEMODE_SYSTEM_DTS_PATH,
  createCodemodeTypeFiles,
} from "@/fragno/codemode/codemode-dts";
import { STATE_TYPES } from "@/fragno/codemode/state-prompt";

import {
  createRuntimeToolFamilyReference,
  createRuntimeToolReferences,
  renderCodemodeProviderTypes,
  stringifyRuntimeToolFamilyReference,
  toRuntimeToolReference,
  type RuntimeToolFamilyReferenceTarget,
} from "./reference";
import { runtimeToolFamilies } from "./tool-families";

const summarizeFamilyReference = (family: (typeof runtimeToolFamilies)[number]) => {
  const reference = createRuntimeToolFamilyReference({ family });
  return {
    namespace: reference.namespace,
    tools: reference.tools.map((tool) => ({
      id: tool.id,
      namespace: tool.namespace,
      codemodeProvider: tool.codemode.providerName,
      codemodeTool: tool.codemode.toolName,
      inputType: tool.codemode.inputTypeName,
      outputType: tool.codemode.outputTypeName,
      bashCommand: tool.bash?.command,
      bashOptions: tool.bash?.options.map((option) => option.name) ?? [],
    })),
  };
};

const findBashFamily = (namespace: string) => {
  const family = runtimeToolFamilies.find((candidate) => candidate.namespace === namespace);
  if (!family) {
    throw new Error(`Missing bash family '${namespace}'`);
  }
  return family;
};

const stringifyFamilyByNamespace = ({
  namespace,
  target,
}: {
  namespace: string;
  target: RuntimeToolFamilyReferenceTarget;
}) =>
  stringifyRuntimeToolFamilyReference({
    reference: createRuntimeToolFamilyReference({ family: findBashFamily(namespace) }),
    target,
  });

const readGeneratedFile = (files: readonly { path: string; content: string }[], path: string) => {
  const file = files.find((candidate) => candidate.path === path);
  assert(file, `Missing generated file ${path}`);
  return file.content;
};

describe("runtime tool reference generation", () => {
  test.each([
    {
      namespace: "store",
      tools: [
        {
          id: "store.get",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "get",
          inputType: "StoreGetInput",
          outputType: "StoreGetOutput",
          bashCommand: "store.get",
          bashOptions: ["key"],
        },
        {
          id: "store.set",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "set",
          inputType: "StoreSetInput",
          outputType: "StoreSetOutput",
          bashCommand: "store.set",
          bashOptions: ["key", "value", "actor", "description", "category", "verification"],
        },
        {
          id: "store.delete",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "delete",
          inputType: "StoreDeleteInput",
          outputType: "StoreDeleteOutput",
          bashCommand: "store.delete",
          bashOptions: ["key"],
        },
        {
          id: "store.list",
          namespace: "store",
          codemodeProvider: "store",
          codemodeTool: "list",
          inputType: "StoreListInput",
          outputType: "StoreListOutput",
          bashCommand: "store.list",
          bashOptions: ["prefix", "limit"],
        },
      ],
    },
    {
      namespace: "events",
      tools: [
        {
          id: "events.list",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "listEvents",
          inputType: "EventsListEventsInput",
          outputType: "EventsListEventsOutput",
          bashCommand: "events.list",
          bashOptions: ["cursor", "page-size"],
        },
        {
          id: "events.get",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "getEvent",
          inputType: "EventsGetEventInput",
          outputType: "EventsGetEventOutput",
          bashCommand: "events.get",
          bashOptions: ["hook-id"],
        },
      ],
    },
    {
      namespace: "event",
      tools: [
        {
          id: "event.emit",
          namespace: "event",
          codemodeProvider: "event",
          codemodeTool: "emit",
          inputType: "EventEmitInput",
          outputType: "EventEmitOutput",
          bashCommand: "event.emit",
          bashOptions: [
            "event-type",
            "source",
            "external-actor-id",
            "actor-type",
            "subject-user-id",
            "payload-json",
            "target-scope-json",
          ],
        },
      ],
    },
    {
      namespace: "hooks",
      tools: [
        {
          id: "hooks.list",
          namespace: "hooks",
          codemodeProvider: "hooks",
          codemodeTool: "list",
          inputType: "HooksListInput",
          outputType: "HooksListOutput",
          bashCommand: "hooks.list",
          bashOptions: ["fragment", "cursor", "page-size"],
        },
        {
          id: "hooks.get",
          namespace: "hooks",
          codemodeProvider: "hooks",
          codemodeTool: "get",
          inputType: "HooksGetInput",
          outputType: "HooksGetOutput",
          bashCommand: "hooks.get",
          bashOptions: ["fragment", "hook-id"],
        },
      ],
    },
    {
      namespace: "otp",
      tools: [
        {
          id: "otp.identity.create-claim",
          namespace: "otp",
          codemodeProvider: "otp",
          codemodeTool: "createIdentityClaim",
          inputType: "OtpCreateIdentityClaimInput",
          outputType: "OtpCreateIdentityClaimOutput",
          bashCommand: "otp.identity.create-claim",
          bashOptions: ["actor-json", "ttl-minutes"],
        },
      ],
    },
    {
      namespace: "pi",
      tools: [
        {
          id: "pi.session.create",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "createSession",
          inputType: "PiCreateSessionInput",
          outputType: "PiCreateSessionOutput",
          bashCommand: "pi.session.create",
          bashOptions: ["agent", "name", "system-message", "tag", "metadata-json", "steering-mode"],
        },
        {
          id: "pi.session.get",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "getSession",
          inputType: "PiGetSessionInput",
          outputType: "PiGetSessionOutput",
          bashCommand: "pi.session.get",
          bashOptions: ["session-id", "events", "trace", "turns"],
        },
        {
          id: "pi.session.list",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "listSessions",
          inputType: "PiListSessionsInput",
          outputType: "PiListSessionsOutput",
          bashCommand: "pi.session.list",
          bashOptions: ["limit"],
        },
        {
          id: "pi.session.turn",
          namespace: "pi",
          codemodeProvider: "pi",
          codemodeTool: "runTurn",
          inputType: "PiRunTurnInput",
          outputType: "PiRunTurnOutput",
          bashCommand: "pi.session.turn",
          bashOptions: ["session-id", "text"],
        },
      ],
    },
    {
      namespace: "resend",
      tools: [
        {
          id: "resend.threads.get",
          namespace: "resend",
          codemodeProvider: "resend",
          codemodeTool: "getThread",
          inputType: "ResendGetThreadInput",
          outputType: "ResendGetThreadOutput",
          bashCommand: "resend.threads.get",
          bashOptions: ["thread-id", "order", "page-size", "cursor"],
        },
        {
          id: "resend.threads.list",
          namespace: "resend",
          codemodeProvider: "resend",
          codemodeTool: "listThreads",
          inputType: "ResendListThreadsInput",
          outputType: "ResendListThreadsOutput",
          bashCommand: "resend.threads.list",
          bashOptions: ["order", "page-size", "cursor"],
        },
        {
          id: "resend.threads.reply",
          namespace: "resend",
          codemodeProvider: "resend",
          codemodeTool: "replyToThread",
          inputType: "ResendReplyToThreadInput",
          outputType: "ResendReplyToThreadOutput",
          bashCommand: "resend.threads.reply",
          bashOptions: ["thread-id", "subject", "body"],
        },
      ],
    },
    {
      namespace: "reson8",
      tools: [
        {
          id: "reson8.prerecorded.transcribe",
          namespace: "reson8",
          codemodeProvider: "reson8",
          codemodeTool: "transcribePrerecorded",
          inputType: "Reson8TranscribePrerecordedInput",
          outputType: "Reson8TranscribePrerecordedOutput",
          bashCommand: "reson8.prerecorded.transcribe",
          bashOptions: [
            "input",
            "encoding",
            "sample-rate",
            "channels",
            "custom-model-id",
            "include-timestamps",
            "include-words",
            "include-confidence",
          ],
        },
      ],
    },
    {
      namespace: "telegram",
      tools: [
        {
          id: "telegram.file.get",
          namespace: "telegram",
          codemodeProvider: "telegram",
          codemodeTool: "getFile",
          inputType: "TelegramGetFileInput",
          outputType: "TelegramGetFileOutput",
          bashCommand: "telegram.file.get",
          bashOptions: ["file-id"],
        },
        {
          id: "telegram.file.download",
          namespace: "telegram",
          codemodeProvider: "telegram",
          codemodeTool: "downloadFile",
          inputType: "TelegramDownloadFileInput",
          outputType: "TelegramDownloadFileOutput",
          bashCommand: "telegram.file.download",
          bashOptions: ["file-id", "output"],
        },
        {
          id: "telegram.chat.send",
          namespace: "telegram",
          codemodeProvider: "telegram",
          codemodeTool: "sendMessage",
          inputType: "TelegramSendMessageInput",
          outputType: "TelegramSendMessageOutput",
          bashCommand: "telegram.chat.send",
          bashOptions: [
            "chat-id",
            "text",
            "parse-mode",
            "disable-web-page-preview",
            "reply-to-message-id",
          ],
        },
        {
          id: "telegram.chat.actions",
          namespace: "telegram",
          codemodeProvider: "telegram",
          codemodeTool: "sendChatAction",
          inputType: "TelegramSendChatActionInput",
          outputType: "TelegramSendChatActionOutput",
          bashCommand: "telegram.chat.actions",
          bashOptions: ["chat-id", "action"],
        },
        {
          id: "telegram.message.edit",
          namespace: "telegram",
          codemodeProvider: "telegram",
          codemodeTool: "editMessage",
          inputType: "TelegramEditMessageInput",
          outputType: "TelegramEditMessageOutput",
          bashCommand: "telegram.message.edit",
          bashOptions: ["chat-id", "message-id", "text", "parse-mode", "disable-web-page-preview"],
        },
      ],
    },
  ])("converts $namespace family tools into reference objects", (expectedFamily) => {
    const family = findBashFamily(expectedFamily.namespace);

    expect(summarizeFamilyReference(family)).toEqual(expectedFamily);
    expect(family.tools.map(toRuntimeToolReference)).toEqual(
      createRuntimeToolFamilyReference({ family }).tools,
    );
  });

  test("stringifies a single bash family for markdown docs", () => {
    expect(stringifyFamilyByNamespace({ namespace: "telegram", target: "bash" }))
      .toMatchInlineSnapshot(`
      "### telegram.*

      - telegram.file.get --file-id <file-id>
        - telegram.file.get resolves Telegram attachment metadata through the Telegram Durable Object.
        - --file-id: Telegram file id to resolve
        - Examples:
          - \`telegram.file.get --file-id "$file_id"\`
          - \`telegram.file.get --file-id "$file_id" --print filePath\`
      - telegram.file.download --file-id <file-id> [--output <path>]
        - telegram.file.download fetches a Telegram file. Use --output (-o) to write directly to a path, or pipe stdout for shell redirections.
        - --file-id: Telegram file id to download
        - --output: Write file directly to this path instead of stdout (-o shorthand)
        - Examples:
          - \`telegram.file.download --file-id "$file_id" -o /workspace/attachment.bin\`
          - \`telegram.file.download --file-id "$file_id" --output /workspace/photo.jpg\`
          - \`telegram.file.download --file-id "$file_id" > /workspace/attachment.bin\`
      - telegram.chat.send --chat-id <chat-id> --text <text> [--parse-mode <mode>] [--disable-web-page-preview] [--reply-to-message-id <message-id>]
        - telegram.chat.send queues a message to be sent to a Telegram chat.
        - --chat-id: Telegram chat id to send to
        - --text: Message text
        - --parse-mode: Parse mode (Markdown|MarkdownV2|HTML). Defaults to Markdown.
        - --disable-web-page-preview: Disable web page previews for links
        - --reply-to-message-id: Reply to this Telegram message id
        - Examples:
          - \`telegram.chat.send --chat-id "$chat_id" --text "Hello from bash"\`
          - \`telegram.chat.send --chat-id "$chat_id" --text "<b>Hello</b>" --parse-mode HTML\`
      - telegram.chat.actions --chat-id <chat-id> [--action <action>]
        - telegram.chat.actions sends a chat action (only typing is supported currently).
        - --chat-id: Telegram chat id
        - --action: Action to send (typing only for now)
        - Examples:
          - \`telegram.chat.actions --chat-id "$chat_id" --action typing\`
          - \`telegram.chat.actions --chat-id "$chat_id" --action typing --format json\`
      - telegram.message.edit --chat-id <chat-id> --message-id <message-id> --text <text> [--parse-mode <mode>] [--disable-web-page-preview]
        - telegram.message.edit queues an edit of an existing Telegram message.
        - --chat-id: Telegram chat id
        - --message-id: Telegram message id to edit
        - --text: New message text
        - --parse-mode: Parse mode (MarkdownV2|Markdown|HTML)
        - --disable-web-page-preview: Disable web page previews for links
        - Examples:
          - \`telegram.message.edit --chat-id "$chat_id" --message-id 123 --text "Updated text"\`"
    `);
  });

  test("stringifies reson8 codemode declarations", () => {
    expect(stringifyFamilyByNamespace({ namespace: "reson8", target: "codemode" }))
      .toMatchInlineSnapshot(`
        "// ── Backoffice domain tool providers ───────────────────────────────────

        // reson8 tools
        type Reson8TranscribePrerecordedInput = {
          audio?: unknown;
          encoding?: "auto" | "pcm_s16le";
          sampleRate?: number;
          channels?: number;
          customModelId?: string;
          includeTimestamps?: boolean;
          includeWords?: boolean;
          includeConfidence?: boolean;
        };
        type Reson8TranscribePrerecordedOutput = {
          text: string;
          start_ms?: number;
          duration_ms?: number;
          words?: {
              text: string;
              start_ms?: number;
              duration_ms?: number;
              confidence?: number;
            }[];
        };

        type Reson8CodemodeProvider = {
          /** Transcribe a prerecorded audio file via Reson8. */
          transcribePrerecorded(input: Reson8TranscribePrerecordedInput): Promise<Reson8TranscribePrerecordedOutput>;
        };
        declare const reson8: Reson8CodemodeProvider;

        // Scoped context handles target a selected Backoffice context.
        type BackofficeCodemodeScopedProviders = {
          reson8: Reson8CodemodeProvider;
        };
        declare const context: {
          /** Providers bound to the selected current context. */
          readonly current: BackofficeCodemodeScopedProviders;
          /** Providers bound to an organisation context. */
          org(orgId: string): BackofficeCodemodeScopedProviders;
          /** Providers bound to a user context. */
          user(userId: string): BackofficeCodemodeScopedProviders;
          /** Project contexts are reserved until the project model exists. */
          project(projectId: string): BackofficeCodemodeScopedProviders;
        };"
      `);
  });

  test("stringifies a single codemode family for provider declarations", () => {
    expect(stringifyFamilyByNamespace({ namespace: "telegram", target: "codemode" }))
      .toMatchInlineSnapshot(`
        "// ── Backoffice domain tool providers ───────────────────────────────────

        // telegram tools
        type TelegramGetFileInput = {
          fileId: string;
        };
        type TelegramGetFileOutput = {
          fileId: string;
          fileUniqueId?: string | null;
          filePath?: string | null;
          fileSize?: number | null;
        };
        type TelegramDownloadFileInput = {
          fileId: string;
        };
        type TelegramDownloadFileOutput = {
          bytes: number[];
          contentType?: string;
        };
        type TelegramSendMessageInput = {
          chatId: string;
          text: string;
          parseMode?: "MarkdownV2" | "Markdown" | "HTML";
          disableWebPagePreview?: boolean;
          replyToMessageId?: number;
        };
        type TelegramSendMessageOutput = {
          ok: boolean;
          queued: boolean;
        };
        type TelegramSendChatActionInput = {
          chatId: string;
          action: "typing";
        };
        type TelegramSendChatActionOutput = {
          ok: boolean;
        };
        type TelegramEditMessageInput = {
          chatId: string;
          messageId: string;
          text: string;
          parseMode?: "MarkdownV2" | "Markdown" | "HTML";
          disableWebPagePreview?: boolean;
        };
        type TelegramEditMessageOutput = {
          ok: boolean;
          queued: boolean;
        };

        type TelegramCodemodeProvider = {
          /** Resolve Telegram attachment metadata. */
          getFile(input: TelegramGetFileInput): Promise<TelegramGetFileOutput>;
          /** Download a Telegram file and return its bytes. */
          downloadFile(input: TelegramDownloadFileInput): Promise<TelegramDownloadFileOutput>;
          /** Queue a message to be sent to a Telegram chat. */
          sendMessage(input: TelegramSendMessageInput): Promise<TelegramSendMessageOutput>;
          /** Send a Telegram chat action. */
          sendChatAction(input: TelegramSendChatActionInput): Promise<TelegramSendChatActionOutput>;
          /** Queue an edit of an existing Telegram message. */
          editMessage(input: TelegramEditMessageInput): Promise<TelegramEditMessageOutput>;
        };
        declare const telegram: TelegramCodemodeProvider;

        // Scoped context handles target a selected Backoffice context.
        type BackofficeCodemodeScopedProviders = {
          telegram: TelegramCodemodeProvider;
        };
        declare const context: {
          /** Providers bound to the selected current context. */
          readonly current: BackofficeCodemodeScopedProviders;
          /** Providers bound to an organisation context. */
          org(orgId: string): BackofficeCodemodeScopedProviders;
          /** Providers bound to a user context. */
          user(userId: string): BackofficeCodemodeScopedProviders;
          /** Project contexts are reserved until the project model exists. */
          project(projectId: string): BackofficeCodemodeScopedProviders;
        };"
      `);
  });

  test("stringifies a single family for dashboard command groups", () => {
    expect(stringifyFamilyByNamespace({ namespace: "pi", target: "dashboard" }))
      .toMatchInlineSnapshot(`
      "[
        {
          "namespace": "pi",
          "commands": [
            "pi.session.create",
            "pi.session.get",
            "pi.session.list",
            "pi.session.turn"
          ]
        }
      ]"
    `);
  });

  test("renders the automation codemode target family list", () => {
    const types = renderCodemodeProviderTypes(
      createRuntimeToolReferences({ families: runtimeToolFamilies }),
    );

    expect(types).toContain("declare const store");
    expect(types).toContain("declare const workflow");
    expect(types).toContain("createInstance(input: WorkflowCreateInstanceInput)");
    expect(types).toContain("getInstance(input: WorkflowGetInstanceInput)");
    expect(types).toContain("retryInstance(input: WorkflowRetryInstanceInput)");
    expect(types).toContain("declare const event");
    expect(types).toContain("declare const telegram");
  });

  test("renders split codemode declarations with every capability enabled", () => {
    expect(() =>
      createCodemodeTypeFiles({
        configuredCapabilityIds: backofficeCapabilities.map((capability) => capability.id),
        families: runtimeToolFamilies,
        stateTypes: STATE_TYPES,
      }),
    ).not.toThrow();
  });

  test("renders split codemode index without referencing state declarations", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: STATE_TYPES,
    });
    const index = files.find((file) => file.path === CODEMODE_SYSTEM_DTS_PATH)?.content;

    expect(index).toContain('/// <reference path="/workspace/codemode/workflow-authoring.d.ts" />');
    expect(index).toContain("type BackofficeCodemodeScopedProviders = {");
    expect(index).toContain("declare const context");
    expect(index).not.toContain('/// <reference path="/workspace/codemode/state.d.ts" />');
    assert(files.some((file) => file.path === CODEMODE_STATE_DTS_PATH));
  });

  test("renders recursive automation route matchers as named codemode types", () => {
    const types = stringifyFamilyByNamespace({ namespace: "router", target: "codemode" });

    expect(types).toContain("type AutomationEventMatcher =");
    expect(types).toContain("all: AutomationEventMatcher[];");
    expect(types).toContain("any: AutomationEventMatcher[];");
    expect(types).toContain("not: AutomationEventMatcher;");
    expect(types).toContain("matcher: AutomationEventMatcher | null;");
    expect(types).not.toContain("matcher: unknown | null;");
    expect(types.match(/type AutomationEventMatcher =/g)).toHaveLength(1);
  });

  test("renders recursive automation route matchers in generated router provider types", () => {
    const files = createCodemodeTypeFiles({
      configuredCapabilityIds: ["automations"],
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
    });
    const types = readGeneratedFile(files, "/workspace/codemode/providers/router.d.ts");

    expect(types).toContain("declare const router");
    expect(types).toContain("type AutomationEventMatcher =");
    expect(types).toContain("matcher: AutomationEventMatcher | null;");
    expect(types).not.toContain("matcher: unknown | null;");
    expect(types.match(/type AutomationEventMatcher =/g)).toHaveLength(1);
  });

  test("emits shared recursive matcher declarations before route input and output aliases", () => {
    const types = stringifyFamilyByNamespace({ namespace: "router", target: "codemode" });
    const matcherIndex = types.indexOf("type AutomationEventMatcher =");
    const listOutputIndex = types.indexOf("type RouterListOutput =");
    const createInputIndex = types.indexOf("type RouterCreateInput =");
    const updateInputIndex = types.indexOf("type RouterUpdateInput =");

    expect(matcherIndex).toBeGreaterThanOrEqual(0);
    expect(matcherIndex).toBeLessThan(listOutputIndex);
    expect(matcherIndex).toBeLessThan(createInputIndex);
    expect(matcherIndex).toBeLessThan(updateInputIndex);
    expect(types).toContain("create(input: RouterCreateInput): Promise<RouterCreateOutput>");
    expect(types).toContain("update(input: RouterUpdateInput): Promise<RouterUpdateOutput>");
  });

  test("dedupes automation route and action declarations in router codemode types", () => {
    const types = stringifyFamilyByNamespace({ namespace: "router", target: "codemode" });

    expect(types).toContain("type RouterListOutput = AutomationRoute[];");
    expect(types).toContain("type RouterGetOutput = AutomationRoute | null;");
    expect(types).toContain("type RouterCreateOutput = AutomationRoute;");
    expect(types).toContain("type RouterUpdateOutput = AutomationRoute | null;");
    expect(types).toContain("action: AutomationRouteAction;");
    expect(types).toContain("action: AutomationRouteActionInput;");
    expect(types).toContain("action?: AutomationRouteActionInput;");
    expect(types).toContain("target: AutomationWorkflowEventTarget;");
    expect(types).toContain(
      "type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;",
    );
    expect(types).toContain('kind: "stored_instance_id";');
    expect(types).toContain("keyTemplate: string;");
    expect(types).toContain(
      "type AutomationRouteAction = AutomationStartWorkflowAction | AutomationSendWorkflowEventAction;",
    );
    expect(types).toContain(
      "type AutomationRouteActionInput = AutomationStartWorkflowActionInput | AutomationSendWorkflowEventActionInput;",
    );
    expect(types).toContain("type AutomationStartWorkflowAction = {");
    expect(types).toContain("type AutomationStartWorkflowActionInput = {");
    expect(types).toContain("workflowName: string;");
    expect(types).toContain("workflowName?: string;");
    expect(types.match(/type AutomationRoute =/g)).toHaveLength(1);
    expect(types.match(/type AutomationRouteAction =/g)).toHaveLength(1);
    expect(types.match(/type AutomationRouteActionInput =/g)).toHaveLength(1);
    expect(types.match(/type AutomationWorkflowEventTarget =/g)).toHaveLength(1);
  });

  test("renders codemode provider files from the default dynamic codemode family list", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: STATE_TYPES,
    });
    const capabilitiesTypes = readGeneratedFile(
      files,
      "/workspace/codemode/providers/capabilities.d.ts",
    );
    const connectionsTypes = readGeneratedFile(
      files,
      "/workspace/codemode/providers/connections.d.ts",
    );
    const workflowTypes = readGeneratedFile(files, "/workspace/codemode/providers/workflow.d.ts");
    const otpTypes = readGeneratedFile(files, "/workspace/codemode/providers/otp.d.ts");

    expect(capabilitiesTypes).toContain("declare const capabilities");
    expect(connectionsTypes).toContain("declare const connections");
    expect(connectionsTypes).toContain("list(input: ConnectionsListInput)");
    expect(connectionsTypes).toContain("configure(input: ConnectionsConfigureInput)");
    expect(readGeneratedFile(files, "/workspace/codemode/providers/store.d.ts")).toContain(
      "declare const store",
    );
    expect(workflowTypes).toContain("declare const workflow");
    expect(workflowTypes).toContain("createInstance(input: WorkflowCreateInstanceInput)");
    expect(workflowTypes).toContain("getInstance(input: WorkflowGetInstanceInput)");
    expect(workflowTypes).toContain("retryInstance(input: WorkflowRetryInstanceInput)");
    expect(otpTypes).toContain("declare const otp");
    assert(!files.some((file) => file.path === "/workspace/codemode/providers/pi.d.ts"));
    assert(!files.some((file) => file.path === "/workspace/codemode/providers/telegram.d.ts"));
  });

  test("renders scoped context handles", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: STATE_TYPES,
    });
    const types = readGeneratedFile(files, CODEMODE_SYSTEM_DTS_PATH);

    expect(types).toContain("readonly current: BackofficeCodemodeScopedProviders;");
    expect(types).toContain("org(orgId: string): BackofficeCodemodeScopedProviders;");
    expect(types).toContain("user(userId: string): BackofficeCodemodeScopedProviders;");
    expect(types).toContain("Project contexts are reserved until the project model exists.");
    expect(types).not.toContain("createOrg");
    expect(types).not.toContain("OrgFileSystem");
    expect(types).not.toContain("org-only");
  });

  test("renders sandbox provider types from the sandbox capability", () => {
    const piFiles = createCodemodeTypeFiles({
      configuredCapabilityIds: ["pi"],
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
    });
    const sandboxFiles = createCodemodeTypeFiles({
      configuredCapabilityIds: ["sandbox"],
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
    });

    expect(readGeneratedFile(piFiles, "/workspace/codemode/providers/pi.d.ts")).toContain(
      "declare const pi",
    );
    assert(!piFiles.some((file) => file.path === "/workspace/codemode/providers/sandbox.d.ts"));
    expect(readGeneratedFile(sandboxFiles, "/workspace/codemode/providers/sandbox.d.ts")).toContain(
      "declare const sandbox",
    );
  });

  test("renders installed MCP providers with dash-safe server slugs", () => {
    const files = createCodemodeTypeFiles({
      configuredCapabilityIds: ["mcp"],
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
      mcpServers: [
        {
          slug: "cloudflare-mcp",
          providerName: "mcp_cloudflare_mcp",
          tools: [
            {
              originalName: "search-docs",
              codemodeName: "search_docs",
              description: "Search docs.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
          ],
        },
      ],
    });
    const types = readGeneratedFile(files, "/workspace/codemode/providers/mcp_cloudflare_mcp.d.ts");

    expect(types).toContain("declare const mcp_cloudflare_mcp");
    expect(types).toContain("search_docs(input: McpCloudflareMcpSearchDocsInput)");
    expect(types).toContain("query: string");
    expect(types).not.toContain("declare const cloudflare-mcp");
  });
});
