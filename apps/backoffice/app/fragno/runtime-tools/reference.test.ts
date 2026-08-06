import { describe, expect, test, assert } from "vitest";

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
import type { BackofficeRuntimeToolFamily } from "./runtime-tools";
import { runtimeToolFamilies } from "./tool-families";

const summarizeFamilyReference = (family: BackofficeRuntimeToolFamily) => {
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

const findBashFamily = (namespace: string): BackofficeRuntimeToolFamily => {
  const families = runtimeToolFamilies.filter((candidate) => candidate.namespace === namespace);
  if (!families.length) {
    throw new Error(`Missing bash family '${namespace}'`);
  }
  return {
    namespace,
    permissions: Object.assign({}, ...families.map((family) => family.permissions)),
    tools: families.flatMap((family) => family.tools),
  };
};

const stringifyFamilyByNamespace = ({
  namespace,
  target,
}: {
  namespace: string;
  target: RuntimeToolFamilyReferenceTarget;
}) =>
  stringifyRuntimeToolFamilyReference({
    reference: createRuntimeToolFamilyReference({
      family: findBashFamily(namespace),
    }),
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
          bashOptions: ["key", "value", "description", "category", "verification"],
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
          id: "events.fire",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "fire",
          inputType: "EventsFireInput",
          outputType: "EventsFireOutput",
          bashCommand: "events.fire",
          bashOptions: [
            "event-type",
            "source",
            "subject-user-id",
            "payload-json",
            "target-scope-json",
          ],
        },
        {
          id: "events.catalog.list",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "catalogList",
          inputType: "EventsCatalogListInput",
          outputType: "EventsCatalogListOutput",
          bashCommand: "events.catalog.list",
          bashOptions: [],
        },
        {
          id: "events.catalog.get",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "catalogGet",
          inputType: "EventsCatalogGetInput",
          outputType: "EventsCatalogGetOutput",
          bashCommand: "events.catalog.get",
          bashOptions: ["source", "event-type"],
        },
        {
          id: "events.catalog.create",
          namespace: "events",
          codemodeProvider: "events",
          codemodeTool: "catalogCreate",
          inputType: "EventsCatalogCreateInput",
          outputType: "EventsCatalogCreateOutput",
          bashCommand: "events.catalog.create",
          bashOptions: ["json"],
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
          bashOptions: ["ttl-minutes"],
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
          bashOptions: [
            "model-json",
            "name",
            "system-message",
            "tag",
            "metadata-json",
            "steering-mode",
          ],
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
        type Reson8CodemodeProvider = {
          /** Transcribe a prerecorded audio file via Reson8. */
          transcribePrerecorded(input: Reson8TranscribePrerecordedInput): Promise<Reson8TranscribePrerecordedOutput>;
        };
        declare const reson8: Reson8CodemodeProvider;

        type Reson8TranscribePrerecordedInput = {
          audio: { kind: "arrayBuffer"; arrayBuffer: ArrayBuffer } | { kind: "arrayBufferView"; arrayBufferView: ArrayBufferView } | { kind: "bytes"; bytes: number[] };
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

    expect(types).toMatchInlineSnapshot(`
      "// ── Backoffice domain tool providers ───────────────────────────────────

      // capabilities tools
      type CapabilitiesCodemodeProvider = {
        /** List Backoffice capabilities and availability/configuration status. */
        list(input: CapabilitiesListInput): Promise<CapabilitiesListOutput>;
      };
      declare const capabilities: CapabilitiesCodemodeProvider;

      type CapabilitiesListInput = Record<string, unknown>;
      type CapabilitiesListOutput = ({
        id: string;
        label: string;
        kind: "connection" | "system";
        available: boolean;
        configured: boolean;
        healthy?: boolean;
        reason?: string;
      })[];

      // hooks tools
      type HooksCodemodeProvider = {
        /** List hook scopes usable with hooks.list --fragment. */
        scopesList(input: HooksScopesListInput): Promise<HooksScopesListOutput>;
        /** List durable hook queue entries for a runtime fragment. */
        list(input: HooksListInput): Promise<HooksListOutput>;
        /** Get a durable hook queue entry by id. */
        get(input: HooksGetInput): Promise<HooksGetOutput>;
      };
      declare const hooks: HooksCodemodeProvider;

      type HooksScopesListInput = Record<string, unknown>;
      type HooksScopesListOutput = ({
        id: string;
        label: string;
        capabilityId: string;
        capabilityLabel: string;
        kind: "connection" | "system";
        configured?: boolean;
        healthy?: boolean;
      })[];
      type HooksListInput = {
        fragment: string;
        cursor?: string;
        pageSize?: number;
      };
      type HooksListOutput = {
        configured: boolean;
        hooksEnabled: boolean;
        namespace: string | null;
        items: ({
            id: string;
            hookName: string;
            status: string;
            attempts: number;
            maxAttempts: number;
            lastAttemptAt: string | null;
            nextRetryAt: string | null;
            createdAt: string | null;
            error: string | null;
            payload: unknown;
          })[];
        cursor?: string;
        hasNextPage: boolean;
      };
      type HooksGetInput = {
        fragment: string;
        hookId: string;
      };
      type HooksGetOutput = {
        id: string;
        hookName: string;
        status: string;
        attempts: number;
        maxAttempts: number;
        lastAttemptAt: string | null;
        nextRetryAt: string | null;
        createdAt: string | null;
        error: string | null;
        payload: unknown;
      } | null;

      // connections tools
      type ConnectionsCodemodeProvider = {
        /** List configurable Backoffice connections and their configuration status. */
        list(input: ConnectionsListInput): Promise<ConnectionsListOutput>;
        /** Get one Backoffice connection status with masked configuration values. */
        get(input: ConnectionsGetInput): Promise<ConnectionsGetOutput>;
        /** Show human steps for configuring a Backoffice connection. */
        setup(input: ConnectionsSetupInput): Promise<ConnectionsSetupOutput>;
        /** Show the accepted configuration fields for a Backoffice connection. */
        schema(input: ConnectionsSchemaInput): Promise<ConnectionsSchemaOutput>;
        /** Verify a Backoffice connection without changing its configuration. */
        verify(input: ConnectionsVerifyInput): Promise<ConnectionsVerifyOutput>;
        /** Reset a Backoffice connection configuration. Requires --confirm <id>. */
        reset(input: ConnectionsResetInput): Promise<ConnectionsResetOutput>;
        /** Configure a Backoffice connection. Secrets are accepted in input but masked in output. */
        configure(input: ConnectionsConfigureInput): Promise<ConnectionsConfigureOutput>;
      };
      declare const connections: ConnectionsCodemodeProvider;

      type ConnectionsListInput = Record<string, unknown>;
      type ConnectionsListOutput = ({
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        hookScopes: string[];
        runtimeToolNamespaces: string[];
        automationEvents: string[];
        missing?: string[];
      })[];
      type ConnectionsGetInput = {
        id: string;
      };
      type ConnectionsGetOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification?: {
            ok: boolean;
            message: string;
          };
      };
      type ConnectionsSetupInput = {
        id: string;
      };
      type ConnectionsSetupOutput = {
        id: string;
        label: string;
        overview: string;
        manualSteps: {
            id: string;
            title: string;
            instructions: string;
            expectedUserInput?: string[];
          }[];
        fields: {
            name: string;
            required?: boolean;
            secret?: boolean;
            description?: string;
          }[];
        verify?: {
            tool: string;
            description: string;
          };
        configureExample: string;
      };
      type ConnectionsSchemaInput = {
        id: string;
      };
      type ConnectionsSchemaOutput = {
        id: string;
        label: string;
        fields: {
            name: string;
            required?: boolean;
            secret?: boolean;
            description?: string;
          }[];
      };
      type ConnectionsVerifyInput = {
        id: string;
      };
      type ConnectionsVerifyOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification: {
            ok: boolean;
            message: string;
          };
      };
      type ConnectionsResetInput = {
        id: string;
        confirm: string;
      };
      type ConnectionsResetOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification?: {
            ok: boolean;
            message: string;
          };
      };
      type ConnectionsConfigureInput = {
        id: string;
        payload: unknown;
        origin?: string;
      };
      type ConnectionsConfigureOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification?: {
            ok: boolean;
            message: string;
          };
      };

      // store tools
      type StoreCodemodeProvider = {
        /** Get an automation store entry by key. */
        get(input: StoreGetInput): Promise<StoreGetOutput>;
        /** Create or update an automation store entry. */
        set(input: StoreSetInput): Promise<StoreSetOutput>;
        /** Delete an automation store entry by key. */
        delete(input: StoreDeleteInput): Promise<StoreDeleteOutput>;
        /** List automation store entries, optionally filtered by key prefix. */
        list(input: StoreListInput): Promise<StoreListOutput>;
      };
      declare const store: StoreCodemodeProvider;

      type StoreGetInput = {
        key: string;
      };
      type StoreGetOutput = {
        id?: string;
        key: string;
        value: string;
        description?: string | null;
        category: string[];
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      } | null;
      type StoreSetInput = {
        key: string;
        value: string;
        description?: string | null;
        category?: string[];
        verification?: {
            type: "json-schema";
            schema: unknown;
          }[];
      };
      type StoreSetOutput = {
        id: string;
        key: string;
        value: string;
        description?: string | null;
        category: string[];
      };
      type StoreDeleteInput = {
        key: string;
      };
      type StoreDeleteOutput = {
        ok: true;
        key: string;
      } | null;
      type StoreListInput = {
        prefix?: string;
        limit?: number;
      };
      type StoreListOutput = ({
        id?: string;
        key: string;
        value: string;
        description?: string | null;
        category: string[];
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      })[];

      // identity tools
      type IdentityCodemodeProvider = {
        /** Resolve an active external identity binding so the workflow can choose its internal user. */
        resolveExternal(input: IdentityResolveExternalInput): Promise<IdentityResolveExternalOutput>;
      };
      declare const identity: IdentityCodemodeProvider;

      type IdentityResolveExternalInput = {
        source: string;
        type: string;
        id: string;
      };
      type IdentityResolveExternalOutput = {
        userId: string;
      } | null;

      // router tools
      type RouterCodemodeProvider = {
        /** List database-backed automation routing rules. */
        list(input: RouterListInput): Promise<RouterListOutput>;
        /** Get one database-backed automation routing rule. */
        get(input: RouterGetInput): Promise<RouterGetOutput>;
        /** Create a database-backed automation routing rule. */
        create(input: RouterCreateInput): Promise<RouterCreateOutput>;
        /** Update a database-backed automation routing rule. */
        update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
        /** Idempotently delete a database-backed automation route. */
        delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
        /** Trigger a scheduled automation route immediately without changing its cadence. */
        triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
      };
      declare const router: RouterCodemodeProvider;

      type AutomationRoute = {
        id: string;
        name: string;
        enabled: boolean;
        priority: number;
        trigger: AutomationRouteTrigger;
        action: AutomationRouteAction;
        description?: string | null;
        nextOccurrenceAt: string | null;
      };
      type AutomationRouteTrigger = {
        kind: "event";
        source: string;
        eventType: string;
        matcher: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone: string;
          };
      };
      type AutomationRouteAction = AutomationStartWorkflowAction | AutomationSendWorkflowEventAction | AutomationForwardEventAction;
      type AutomationEventMatcher = {
        actor: {
            participation: "initiator";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "initiator";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "delegation";
            scope: "internal";
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          } | {
            participation: "delegation";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          };
      } | {
        path: string;
        op: "exists";
      } | {
        path: string;
        op: "eq" | "neq" | "startsWith" | "includes";
        value: unknown;
      } | {
        all: AutomationEventMatcher[];
      } | {
        any: AutomationEventMatcher[];
      } | {
        not: AutomationEventMatcher;
      };
      type AutomationStartWorkflowAction = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventAction = {
        kind: "send_workflow_event";
        workflowName: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventAction = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;
      type AutomationRouteScopeTemplate = {
        kind: "system";
      } | {
        kind: "org";
        orgIdTemplate: string;
      } | {
        kind: "project";
        orgIdTemplate: string;
        projectIdTemplate: string;
      } | {
        kind: "user";
        userIdTemplate: string;
      };
      type AutomationWorkflowEventInstanceIdTarget = {
        kind: "instance_id";
        template: string;
      };
      type AutomationWorkflowEventStoredInstanceIdTarget = {
        kind: "stored_instance_id";
        keyTemplate: string;
      };
      type AutomationRouteTriggerInput = {
        kind: "event";
        source: string;
        eventType: string;
        matcher?: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone?: string;
          };
      };
      type AutomationRouteActionInput = AutomationStartWorkflowActionInput | AutomationSendWorkflowEventActionInput | AutomationForwardEventActionInput;
      type AutomationStartWorkflowActionInput = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventActionInput = {
        kind: "send_workflow_event";
        workflowName?: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventActionInput = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type RouterListInput = Record<string, unknown>;
      type RouterListOutput = AutomationRoute[];
      type RouterGetInput = {
        id: string;
      };
      type RouterGetOutput = AutomationRoute | null;
      type RouterCreateInput = {
        id: string;
        name: string;
        enabled?: boolean;
        priority?: number;
        trigger: AutomationRouteTriggerInput;
        action: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterCreateOutput = AutomationRoute;
      type RouterUpdateInput = {
        id: string;
        name?: string;
        enabled?: boolean;
        priority?: number;
        trigger?: AutomationRouteTriggerInput;
        action?: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterUpdateOutput = AutomationRoute | null;
      type RouterDeleteInput = {
        id: string;
      };
      type RouterDeleteOutput = {
        deleted: true;
      };
      type RouterTriggerNowInput = {
        id: string;
      };
      type RouterTriggerNowOutput = {
        accepted: true;
        eventId: string;
      } | null;

      // workflow tools
      type WorkflowCodemodeProvider = {
        /** List registered durable workflows. */
        listWorkflows(input: WorkflowListWorkflowsInput): Promise<WorkflowListWorkflowsOutput>;
        /** Create a durable workflow instance. */
        createInstance(input: WorkflowCreateInstanceInput): Promise<WorkflowCreateInstanceOutput>;
        /** List durable workflow instances. */
        listInstances(input: WorkflowListInstancesInput): Promise<WorkflowListInstancesOutput>;
        /** Get durable workflow instance details. */
        getInstance(input: WorkflowGetInstanceInput): Promise<WorkflowGetInstanceOutput>;
        /** Get durable workflow step, event, and emission history. */
        getHistory(input: WorkflowGetHistoryInput): Promise<WorkflowGetHistoryOutput>;
        /** Send an event to a waiting durable workflow instance. */
        sendEvent(input: WorkflowSendEventInput): Promise<WorkflowSendEventOutput>;
        /** Retry a durable workflow instance step. */
        retryInstance(input: WorkflowRetryInstanceInput): Promise<WorkflowRetryInstanceOutput>;
      };
      declare const workflow: WorkflowCodemodeProvider;

      type WorkflowListWorkflowsInput = Record<string, unknown>;
      type WorkflowListWorkflowsOutput = {
        workflows: {
            name: string;
          }[];
      };
      type WorkflowCreateInstanceInput = {
        workflowName: string;
        remoteWorkflowName?: string;
        instanceId?: string;
        params?: unknown;
      };
      type WorkflowCreateInstanceOutput = {
        workflowName: string;
        instanceId: string;
      };
      type WorkflowListInstancesInput = {
        workflowName: string;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        remoteWorkflowName?: string;
        pageSize?: number;
        cursor?: string;
      };
      type WorkflowListInstancesOutput = {
        instances: ({
            id: string;
            details: {
                  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
                  error?: {
                          name: string;
                          message: string;
                        };
                  output?: unknown;
                };
            createdAt: string;
          })[];
        nextCursor?: string;
        hasNextPage: boolean;
      };
      type WorkflowGetInstanceInput = {
        workflowName: string;
        instanceId: string;
      };
      type WorkflowGetInstanceOutput = {
        id: string;
        details: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        meta: {
            [key: string]: unknown;
          };
      };
      type WorkflowGetHistoryInput = {
        workflowName: string;
        instanceId: string;
      };
      type WorkflowGetHistoryOutput = {
        steps: unknown[];
        events: unknown[];
        emissions: unknown[];
      };
      type WorkflowSendEventInput = {
        workflowName: string;
        instanceId: string;
        type: string;
        payload?: unknown;
      };
      type WorkflowSendEventOutput = unknown;
      type WorkflowRetryInstanceInput = {
        workflowName: string;
        instanceId: string;
        stepKey?: string;
        delayMs?: number;
        reason?: string;
      };
      type WorkflowRetryInstanceOutput = {
        accepted: true;
        instance: {
            id: string;
            details: {
                  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
                  error?: {
                          name: string;
                          message: string;
                        };
                  output?: unknown;
                };
          };
        retry: {
            stepKey: string;
            attempts: number;
            maxAttempts: number;
            scheduledAt: string;
          };
      };

      // events tools
      type EventsCodemodeProvider = {
        /** Fire an automation event for the current context or a selected target scope. */
        fire(input: EventsFireInput): Promise<EventsFireOutput>;
        /** List known automation event source/type pairs from the Backoffice capability registry. */
        catalogList(input: EventsCatalogListInput): Promise<EventsCatalogListOutput>;
        /** Get one automation event descriptor and its JSON schemas. */
        catalogGet(input: EventsCatalogGetInput): Promise<EventsCatalogGetOutput>;
        /** Create a scoped dynamic automation event definition with optional JSON schemas. */
        catalogCreate(input: EventsCatalogCreateInput): Promise<EventsCatalogCreateOutput>;
      };
      declare const events: EventsCodemodeProvider;

      type EventsFireInput = {
        eventType: string;
        source?: string;
        subjectUserId?: string;
        payload?: {
            [key: string]: unknown;
          };
        targetScope?: {
            kind: "system";
          } | {
            kind: "org";
            orgId: string;
          } | {
            kind: "user";
            userId: string;
          } | {
            kind: "project";
            orgId: string;
            projectId: string;
          };
      };
      type EventsFireOutput = {
        accepted: boolean;
        eventId: string;
        scope: {
            kind: "system";
          } | {
            kind: "org";
            orgId: string;
          } | {
            kind: "user";
            userId: string;
          } | {
            kind: "project";
            orgId: string;
            projectId: string;
          };
        source: string;
        eventType: string;
      };
      type EventsCatalogListInput = Record<string, unknown>;
      type EventsCatalogListOutput = {
        source: string;
        eventType: string;
        label: string;
        description?: string;
        capabilityId: string;
        example?: unknown;
      }[];
      type EventsCatalogGetInput = {
        source: string;
        eventType: string;
      };
      type EventsCatalogGetOutput = {
        source: string;
        eventType: string;
        label: string;
        description?: string;
        capabilityId: string;
        payloadSchema?: {
            [key: string]: unknown;
          };
        actorSchema?: {
            [key: string]: unknown;
          };
        subjectSchema?: {
            [key: string]: unknown;
          };
        example?: unknown;
      } | null;
      type EventsCatalogCreateInput = {
        source: string;
        eventType: string;
        label: string;
        description?: string | null;
        payloadSchema?: {
            [key: string]: unknown;
          } | null;
        actorSchema?: {
            [key: string]: unknown;
          } | null;
        subjectSchema?: {
            [key: string]: unknown;
          } | null;
        example?: unknown | null;
        enabled?: boolean;
      };
      type EventsCatalogCreateOutput = {
        id: string;
        source: string;
        eventType: string;
        label: string;
        description?: string | null;
        payloadSchema?: {
            [key: string]: unknown;
          } | null;
        actorSchema?: {
            [key: string]: unknown;
          } | null;
        subjectSchema?: {
            [key: string]: unknown;
          } | null;
        example?: unknown | null;
        enabled: boolean;
        capabilityId: string;
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      };

      // cloudflare tools
      type CloudflareCodemodeProvider = {
        /** Capture a page as a PDF or screenshot with Cloudflare Browser Run. */
        browserRunCapture(input: CloudflareBrowserRunCaptureInput): Promise<CloudflareBrowserRunCaptureOutput>;
        /** Start, inspect, or cancel a Cloudflare Browser Run crawl job. */
        browserRunCrawl(input: CloudflareBrowserRunCrawlInput): Promise<CloudflareBrowserRunCrawlOutput>;
      };
      declare const cloudflare: CloudflareCodemodeProvider;

      type CloudflareBrowserRunCaptureInput = {
        action: "pdf";
        input: {
            url?: string;
            html?: string;
            [key: string]: unknown;
          };
      } | {
        action: "screenshot";
        input: {
            url?: string;
            html?: string;
            [key: string]: unknown;
          };
      };
      type CloudflareBrowserRunCaptureOutput = {
        contentType: string;
        data: string;
      };
      type CloudflareBrowserRunCrawlInput = {
        action: "start";
        input: {
            url: string;
            [key: string]: unknown;
          };
      } | {
        action: "get";
        jobId: string;
      } | {
        action: "cancel";
        jobId: string;
      };
      type CloudflareBrowserRunCrawlOutput = {
        action: "start";
        result: {
            jobId: string;
          };
      } | {
        action: "get";
        result: unknown;
      } | {
        action: "cancel";
        result: unknown;
      };

      // web tools
      type WebCodemodeProvider = {
        /** Extract page content or Markdown from a URL or HTML. */
        extract(input: WebExtractInput): Promise<WebExtractOutput>;
      };
      declare const web: WebCodemodeProvider;

      type WebExtractInput = {
        action: "content";
        input: {
            url?: string;
            html?: string;
            [key: string]: unknown;
          };
      } | {
        action: "markdown";
        input: {
            url?: string;
            html?: string;
            [key: string]: unknown;
          };
      };
      type WebExtractOutput = {
        action: "content";
        result: string;
      } | {
        action: "markdown";
        result: string;
      };

      // api tools
      type ApiCodemodeProvider = {
        /** List API connections configured for the current scope. */
        listConnections(input: ApiListConnectionsInput): Promise<ApiListConnectionsOutput>;
        /** Create an outbound HTTP API connection. */
        createConnection(input: ApiCreateConnectionInput): Promise<ApiCreateConnectionOutput>;
        /** Delete an API connection and its stored auth state. */
        deleteConnection(input: ApiDeleteConnectionInput): Promise<ApiDeleteConnectionOutput>;
        /** Read auth status for an API connection. */
        getAuthStatus(input: ApiGetAuthStatusInput): Promise<ApiGetAuthStatusOutput>;
        /** Store a bearer token for a configured API connection. */
        setToken(input: ApiSetTokenInput): Promise<ApiSetTokenOutput>;
        /** Start OAuth login for a configured API connection and return the authorization URL. */
        startOAuth(input: ApiStartOAuthInput): Promise<ApiStartOAuthOutput>;
        /** Delete stored auth for an API connection. */
        deleteAuth(input: ApiDeleteAuthInput): Promise<ApiDeleteAuthOutput>;
        /** List API webhook endpoints configured for the current scope. */
        listWebhookEndpoints(input: ApiListWebhookEndpointsInput): Promise<ApiListWebhookEndpointsOutput>;
        /** Read an API webhook endpoint. */
        getWebhookEndpoint(input: ApiGetWebhookEndpointInput): Promise<ApiGetWebhookEndpointOutput>;
        /** Create or replace an API webhook endpoint. */
        createWebhookEndpoint(input: ApiCreateWebhookEndpointInput): Promise<ApiCreateWebhookEndpointOutput>;
        /** Update an API webhook endpoint. */
        updateWebhookEndpoint(input: ApiUpdateWebhookEndpointInput): Promise<ApiUpdateWebhookEndpointOutput>;
        /** Delete an API webhook endpoint. */
        deleteWebhookEndpoint(input: ApiDeleteWebhookEndpointInput): Promise<ApiDeleteWebhookEndpointOutput>;
        /** Execute an HTTP request through a configured API connection. */
        request(input: ApiRequestInput): Promise<ApiRequestOutput>;
      };
      declare const api: ApiCodemodeProvider;

      type ApiListConnectionsInput = Record<string, unknown>;
      type ApiListConnectionsOutput = {
        connections: ({
            slug: string;
            name?: string | null;
            baseUrl: string;
            authMode: string;
            status: string;
            createdAt?: string;
            updatedAt?: string;
          })[];
      };
      type ApiCreateConnectionInput = {
        slug: string;
        name?: string;
        baseUrl: string;
        auth?: {
            type: "none";
          } | {
            type: "bearer";
            token: string;
          } | {
            type: "oauth";
            authorizationEndpoint: string;
            tokenEndpoint: string;
            clientId: string;
            clientSecret?: string;
            scopes?: string[];
            tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
          } | {
            type: "client_credentials";
            tokenEndpoint: string;
            clientId: string;
            clientSecret: string;
            scopes?: string[];
            audience?: string;
            tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
          };
      };
      type ApiCreateConnectionOutput = {
        slug: string;
        name?: string | null;
        baseUrl: string;
        authMode: string;
        status: string;
        createdAt?: string;
        updatedAt?: string;
      };
      type ApiDeleteConnectionInput = {
        slug: string;
      };
      type ApiDeleteConnectionOutput = {
        ok: true;
      };
      type ApiGetAuthStatusInput = {
        slug: string;
      };
      type ApiGetAuthStatusOutput = {
        authenticated: boolean;
        mode: string;
        expiresAt?: string | null;
      };
      type ApiSetTokenInput = {
        slug: string;
        token: string;
      };
      type ApiSetTokenOutput = {
        authenticated: boolean;
        mode: string;
        expiresAt?: string | null;
      };
      type ApiStartOAuthInput = {
        slug: string;
        scopes?: string[];
        extraAuthorizationParams?: {
            [key: string]: string;
          };
      };
      type ApiStartOAuthOutput = {
        authorizationUrl: string;
        state: string;
      };
      type ApiDeleteAuthInput = {
        slug: string;
      };
      type ApiDeleteAuthOutput = {
        ok: true;
      };
      type ApiListWebhookEndpointsInput = Record<string, unknown>;
      type ApiListWebhookEndpointsOutput = {
        endpoints: ({
            id: string;
            name: string;
            status: "draft" | "active" | "disabled";
            authConfig: {
                  type: "none";
                } | {
                  type: "bearer";
                  tokenRef: string;
                } | {
                  type: "apiKey";
                  location: "header" | "query";
                  name: string;
                  secretRef: string;
                } | {
                  type: "basic";
                  usernameRef: string;
                  passwordRef: string;
                } | {
                  type: "hmac";
                  secretRef: string;
                  algorithm: "sha1" | "sha256" | "sha512";
                  signature: {
                          location: "header" | "query";
                          name: string;
                          encoding: "hex" | "base64" | "base64url";
                          prefix?: string;
                        };
                  signedPayload: {
                          type: "rawBody";
                        } | {
                          type: "timestampBody";
                          timestampHeader: string;
                          delimiter: string;
                          toleranceSeconds: number;
                        };
                };
            deliveryIdentity: {
                  type: "header";
                  name: string;
                } | {
                  type: "query";
                  name: string;
                } | {
                  type: "jsonBodyPath";
                  path: string[];
                };
            secretRefs: string[];
            createdAt?: string;
            updatedAt?: string;
            publicUrl: string | null;
          })[];
      };
      type ApiGetWebhookEndpointInput = {
        endpointId: string;
      };
      type ApiGetWebhookEndpointOutput = {
        id: string;
        name: string;
        status: "draft" | "active" | "disabled";
        authConfig: {
            type: "none";
          } | {
            type: "bearer";
            tokenRef: string;
          } | {
            type: "apiKey";
            location: "header" | "query";
            name: string;
            secretRef: string;
          } | {
            type: "basic";
            usernameRef: string;
            passwordRef: string;
          } | {
            type: "hmac";
            secretRef: string;
            algorithm: "sha1" | "sha256" | "sha512";
            signature: {
                  location: "header" | "query";
                  name: string;
                  encoding: "hex" | "base64" | "base64url";
                  prefix?: string;
                };
            signedPayload: {
                  type: "rawBody";
                } | {
                  type: "timestampBody";
                  timestampHeader: string;
                  delimiter: string;
                  toleranceSeconds: number;
                };
          };
        deliveryIdentity: {
            type: "header";
            name: string;
          } | {
            type: "query";
            name: string;
          } | {
            type: "jsonBodyPath";
            path: string[];
          };
        secretRefs: string[];
        createdAt?: string;
        updatedAt?: string;
        publicUrl: string | null;
      };
      type ApiCreateWebhookEndpointInput = {
        name: string;
        status?: "draft" | "active" | "disabled";
        deliveryIdentity: {
            type: "header";
            name: string;
          } | {
            type: "query";
            name: string;
          } | {
            type: "jsonBodyPath";
            path: string[];
          };
        auth: {
            type: "none";
          } | {
            type: "bearer";
            token: string;
          } | {
            type: "apiKey";
            location: "header" | "query";
            name: string;
            secret: string;
          } | {
            type: "basic";
            username: string;
            password: string;
          } | {
            type: "hmac";
            secret: string;
            algorithm: "sha1" | "sha256" | "sha512";
            signature: {
                  location: "header" | "query";
                  name: string;
                  encoding: "hex" | "base64" | "base64url";
                  prefix?: string;
                };
            signedPayload: {
                  type: "rawBody";
                } | {
                  type: "timestampBody";
                  timestampHeader: string;
                  delimiter: string;
                  toleranceSeconds: number;
                };
          };
        endpointId: string;
      };
      type ApiCreateWebhookEndpointOutput = {
        id: string;
        name: string;
        status: "draft" | "active" | "disabled";
        authConfig: {
            type: "none";
          } | {
            type: "bearer";
            tokenRef: string;
          } | {
            type: "apiKey";
            location: "header" | "query";
            name: string;
            secretRef: string;
          } | {
            type: "basic";
            usernameRef: string;
            passwordRef: string;
          } | {
            type: "hmac";
            secretRef: string;
            algorithm: "sha1" | "sha256" | "sha512";
            signature: {
                  location: "header" | "query";
                  name: string;
                  encoding: "hex" | "base64" | "base64url";
                  prefix?: string;
                };
            signedPayload: {
                  type: "rawBody";
                } | {
                  type: "timestampBody";
                  timestampHeader: string;
                  delimiter: string;
                  toleranceSeconds: number;
                };
          };
        deliveryIdentity: {
            type: "header";
            name: string;
          } | {
            type: "query";
            name: string;
          } | {
            type: "jsonBodyPath";
            path: string[];
          };
        secretRefs: string[];
        createdAt?: string;
        updatedAt?: string;
        publicUrl: string | null;
      };
      type ApiUpdateWebhookEndpointInput = {
        name?: string;
        status?: "draft" | "active" | "disabled";
        deliveryIdentity?: {
            type: "header";
            name: string;
          } | {
            type: "query";
            name: string;
          } | {
            type: "jsonBodyPath";
            path: string[];
          };
        auth?: {
            type: "none";
          } | {
            type: "bearer";
            token: string;
          } | {
            type: "apiKey";
            location: "header" | "query";
            name: string;
            secret: string;
          } | {
            type: "basic";
            username: string;
            password: string;
          } | {
            type: "hmac";
            secret: string;
            algorithm: "sha1" | "sha256" | "sha512";
            signature: {
                  location: "header" | "query";
                  name: string;
                  encoding: "hex" | "base64" | "base64url";
                  prefix?: string;
                };
            signedPayload: {
                  type: "rawBody";
                } | {
                  type: "timestampBody";
                  timestampHeader: string;
                  delimiter: string;
                  toleranceSeconds: number;
                };
          };
        endpointId: string;
      };
      type ApiUpdateWebhookEndpointOutput = {
        id: string;
        name: string;
        status: "draft" | "active" | "disabled";
        authConfig: {
            type: "none";
          } | {
            type: "bearer";
            tokenRef: string;
          } | {
            type: "apiKey";
            location: "header" | "query";
            name: string;
            secretRef: string;
          } | {
            type: "basic";
            usernameRef: string;
            passwordRef: string;
          } | {
            type: "hmac";
            secretRef: string;
            algorithm: "sha1" | "sha256" | "sha512";
            signature: {
                  location: "header" | "query";
                  name: string;
                  encoding: "hex" | "base64" | "base64url";
                  prefix?: string;
                };
            signedPayload: {
                  type: "rawBody";
                } | {
                  type: "timestampBody";
                  timestampHeader: string;
                  delimiter: string;
                  toleranceSeconds: number;
                };
          };
        deliveryIdentity: {
            type: "header";
            name: string;
          } | {
            type: "query";
            name: string;
          } | {
            type: "jsonBodyPath";
            path: string[];
          };
        secretRefs: string[];
        createdAt?: string;
        updatedAt?: string;
        publicUrl: string | null;
      };
      type ApiDeleteWebhookEndpointInput = {
        endpointId: string;
      };
      type ApiDeleteWebhookEndpointOutput = {
        ok: true;
      };
      type ApiRequestInput = {
        slug: string;
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        path: string;
        query?: {
            [key: string]: string;
          };
        headers?: {
            [key: string]: string;
          };
        json?: unknown;
        body?: string;
        timeoutMs?: number;
      };
      type ApiRequestOutput = {
        status: number;
        statusText: string;
        headers: {
            [key: string]: string;
          };
        body: unknown | null;
      };

      // mcp tools
      type McpCodemodeProvider = {
        /** List MCP servers configured for the current organisation. */
        listServers(input: McpListServersInput): Promise<McpListServersOutput>;
        /** Register a remote streamable HTTP MCP server. */
        createServer(input: McpCreateServerInput): Promise<McpCreateServerOutput>;
        /** Delete an MCP server and its stored auth state. */
        deleteServer(input: McpDeleteServerInput): Promise<McpDeleteServerOutput>;
        /** Refresh a configured MCP server and update its cached tool list. */
        refreshServer(input: McpRefreshServerInput): Promise<McpRefreshServerOutput>;
        /** Call a tool exposed by a configured MCP server. */
        callTool(input: McpCallToolInput): Promise<McpCallToolOutput>;
        /** Start OAuth login for a configured MCP server and return the authorization URL. */
        startOAuth(input: McpStartOAuthInput): Promise<McpStartOAuthOutput>;
        /** Store a bearer token for a configured MCP server. */
        setToken(input: McpSetTokenInput): Promise<McpSetTokenOutput>;
      };
      declare const mcp: McpCodemodeProvider;

      type McpListServersInput = Record<string, unknown>;
      type McpListServersOutput = {
        servers: ({
            slug: string;
            name?: string | null;
            endpointUrl: string;
            authMode: string;
            cache?: {
                  protocolVersion?: string | null;
                  serverInfo?: unknown | null;
                  capabilities?: unknown | null;
                  tools?: {
                          name: string;
                          title?: string;
                          description?: string;
                          inputSchema?: {
                                    [key: string]: unknown;
                                  };
                          annotations?: {
                                    [key: string]: unknown;
                                  };
                          _meta?: {
                                    [key: string]: unknown;
                                  };
                        }[] | null;
                  updatedAt?: string;
                } | null;
          })[];
      };
      type McpCreateServerInput = {
        slug: string;
        name?: string;
        endpointUrl: string;
        auth?: {
            type: "none";
          } | {
            type: "bearer";
            token: string;
          } | {
            type: "oauth";
            clientId?: string;
            clientSecret?: string;
            scopes?: string[];
          } | {
            type: "client_credentials";
            clientId: string;
            clientSecret: string;
            scopes?: string[];
          };
      };
      type McpCreateServerOutput = {
        slug: string;
        name?: string | null;
        endpointUrl: string;
        authMode: string;
        cache?: {
            protocolVersion?: string | null;
            serverInfo?: unknown | null;
            capabilities?: unknown | null;
            tools?: {
                  name: string;
                  title?: string;
                  description?: string;
                  inputSchema?: {
                          [key: string]: unknown;
                        };
                  annotations?: {
                          [key: string]: unknown;
                        };
                  _meta?: {
                          [key: string]: unknown;
                        };
                }[] | null;
            updatedAt?: string;
          } | null;
      };
      type McpDeleteServerInput = {
        slug: string;
      };
      type McpDeleteServerOutput = {
        ok: true;
      };
      type McpRefreshServerInput = {
        slug: string;
      };
      type McpRefreshServerOutput = {
        ok: boolean;
        tools: {
            name: string;
            title?: string;
            description?: string;
            inputSchema?: {
                  [key: string]: unknown;
                };
            annotations?: {
                  [key: string]: unknown;
                };
            _meta?: {
                  [key: string]: unknown;
                };
          }[];
        stage: "auth" | "list_tools" | null;
        checkedAt: string;
        server: {
            slug: string;
            name?: string | null;
            endpointUrl: string;
            authMode: string;
          };
        auth: {
            authenticated: boolean;
            mode: string;
            tokenPresent: boolean;
            expiresAt: string | null;
            expired: boolean | null;
            scopes: {
                  requested: string[] | null;
                  granted: string[] | null;
                  missing: string[] | null;
                  raw: string | null;
                };
          };
        live: {
            reachable: boolean;
            listToolsOk: boolean;
            toolCount: number | null;
            protocolVersion: string | null;
            serverInfo: unknown | null;
            capabilities: unknown | null;
          };
        cache: {
            presentBeforeCheck: boolean;
            previousToolCount: number | null;
            updatedToolCount: number | null;
          };
        error: {
            code: string;
            message: string;
          } | null;
      };
      type McpCallToolInput = {
        slug: string;
        name: string;
        arguments?: {
            [key: string]: unknown;
          };
        timeoutMs?: number;
      };
      type McpCallToolOutput = {
        [key: string]: unknown;
      };
      type McpStartOAuthInput = {
        slug: string;
        scope?: string;
        clientId?: string;
        clientSecret?: string;
      };
      type McpStartOAuthOutput = {
        authorizationUrl: string;
        state: string;
      };
      type McpSetTokenInput = {
        slug: string;
        token: string;
      };
      type McpSetTokenOutput = {
        authenticated: boolean;
        mode: string;
      };

      // otp tools
      type OtpCodemodeProvider = {
        /** Create a short-lived identity claim URL for the trusted external initiator. */
        createIdentityClaim(input: OtpCreateIdentityClaimInput): Promise<OtpCreateIdentityClaimOutput>;
      };
      declare const otp: OtpCodemodeProvider;

      type OtpCreateIdentityClaimInput = {
        ttlMinutes?: number;
      };
      type OtpCreateIdentityClaimOutput = {
        url: string;
        otpId: string;
        externalId: string;
        code: string;
        actor: {
            scope: "external";
            source: string;
            type: string;
            id: string;
          };
        type?: string;
        expiresAt?: string;
      };

      // pi tools
      type PiCodemodeProvider = {
        /** Create a new Pi session. */
        createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
        /** Retrieve a Pi session by id. */
        getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
        /** List Pi sessions ordered by creation time. */
        listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
        /** Send one prompt command through a Pi active session and return the settled result. */
        runTurn(input: PiRunTurnInput): Promise<PiRunTurnOutput>;
      };
      declare const pi: PiCodemodeProvider;

      type PiCreateSessionInput = {
        model?: {
            provider: "openai" | "anthropic" | "gemini";
            name: string;
          };
        name?: string;
        systemMessage?: string;
        metadata?: {
            [key: string]: unknown;
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiCreateSessionOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiGetSessionInput = {
        sessionId: string;
        events?: boolean;
        trace?: boolean;
        turns?: boolean;
      };
      type PiGetSessionOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        workflow: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        agent: {
            state: {
                  messages: unknown[];
                  errorMessage?: string;
                };
            completedStepKeys: string[];
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiListSessionsInput = {
        limit?: number;
      };
      type PiListSessionsOutput = ({
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      })[];
      type PiRunTurnInput = {
        sessionId: string;
        text: string;
      };
      type PiRunTurnOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        workflow: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        agent: {
            state: {
                  messages: unknown[];
                  errorMessage?: string;
                };
            completedStepKeys: string[];
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
        assistantText: string;
        commandStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        stream: unknown[];
        terminalState: {
            messages: unknown[];
            errorMessage?: string;
          };
      };

      // resend tools
      type ResendCodemodeProvider = {
        /** Load a Resend thread with a page of messages and a Markdown snapshot. */
        getThread(input: ResendGetThreadInput): Promise<ResendGetThreadOutput>;
        /** List Resend email threads. */
        listThreads(input: ResendListThreadsInput): Promise<ResendListThreadsOutput>;
        /** Send a text reply into an existing Resend thread. */
        replyToThread(input: ResendReplyToThreadInput): Promise<ResendReplyToThreadOutput>;
      };
      declare const resend: ResendCodemodeProvider;

      type ResendGetThreadInput = {
        cursor?: string;
        pageSize?: number;
        order?: "asc" | "desc";
        threadId: string;
      };
      type ResendGetThreadOutput = {
        thread: {
            id: string;
            subject: string | null;
            normalizedSubject: string;
            participants: string[];
            messageCount: number;
            /** ISO 8601 datetime string. */
            firstMessageAt: string;
            /** ISO 8601 datetime string. */
            lastMessageAt: string;
            lastDirection: string | null;
            lastMessagePreview: string | null;
            /** ISO 8601 datetime string. */
            createdAt: string;
            /** ISO 8601 datetime string. */
            updatedAt: string;
            replyToAddress: string | null;
          };
        messages: ({
            id: string;
            threadId: string;
            direction: "inbound" | "outbound";
            status: string;
            from: string | null;
            to: string[];
            cc: string[];
            bcc: string[];
            replyTo: string[];
            subject: string | null;
            normalizedSubject: string;
            participants: string[];
            messageId: string | null;
            inReplyTo: string | null;
            references: string[];
            providerEmailId: string | null;
            attachments: ({
                  id: string;
                  filename: string | null;
                  size: number;
                  contentType: string;
                  contentDisposition: string | null;
                  contentId: string | null;
                })[];
            html: string | null;
            text: string | null;
            headers: {
                  [key: string]: string;
                } | null;
            /** ISO 8601 datetime string. */
            occurredAt: string;
            scheduledAt: string | null;
            sentAt: string | null;
            lastEventType: string | null;
            lastEventAt: string | null;
            errorCode: string | null;
            errorMessage: string | null;
            /** ISO 8601 datetime string. */
            createdAt: string;
            /** ISO 8601 datetime string. */
            updatedAt: string;
          })[];
        cursor?: string;
        hasNextPage: boolean;
        markdown: string;
      };
      type ResendListThreadsInput = {
        cursor?: string;
        pageSize?: number;
        order?: "asc" | "desc";
      };
      type ResendListThreadsOutput = {
        threads: ({
            id: string;
            subject: string | null;
            normalizedSubject: string;
            participants: string[];
            messageCount: number;
            /** ISO 8601 datetime string. */
            firstMessageAt: string;
            /** ISO 8601 datetime string. */
            lastMessageAt: string;
            lastDirection: string | null;
            lastMessagePreview: string | null;
            /** ISO 8601 datetime string. */
            createdAt: string;
            /** ISO 8601 datetime string. */
            updatedAt: string;
          })[];
        cursor?: string;
        hasNextPage: boolean;
      };
      type ResendReplyToThreadInput = {
        threadId: string;
        subject?: string;
        body: string;
      };
      type ResendReplyToThreadOutput = {
        thread: {
            id: string;
            subject: string | null;
            normalizedSubject: string;
            participants: string[];
            messageCount: number;
            /** ISO 8601 datetime string. */
            firstMessageAt: string;
            /** ISO 8601 datetime string. */
            lastMessageAt: string;
            lastDirection: string | null;
            lastMessagePreview: string | null;
            /** ISO 8601 datetime string. */
            createdAt: string;
            /** ISO 8601 datetime string. */
            updatedAt: string;
            replyToAddress: string | null;
          };
        message: {
            id: string;
            threadId: string;
            direction: "inbound" | "outbound";
            status: string;
            from: string | null;
            to: string[];
            cc: string[];
            bcc: string[];
            replyTo: string[];
            subject: string | null;
            normalizedSubject: string;
            participants: string[];
            messageId: string | null;
            inReplyTo: string | null;
            references: string[];
            providerEmailId: string | null;
            attachments: ({
                  id: string;
                  filename: string | null;
                  size: number;
                  contentType: string;
                  contentDisposition: string | null;
                  contentId: string | null;
                })[];
            html: string | null;
            text: string | null;
            headers: {
                  [key: string]: string;
                } | null;
            /** ISO 8601 datetime string. */
            occurredAt: string;
            scheduledAt: string | null;
            sentAt: string | null;
            lastEventType: string | null;
            lastEventAt: string | null;
            errorCode: string | null;
            errorMessage: string | null;
            /** ISO 8601 datetime string. */
            createdAt: string;
            /** ISO 8601 datetime string. */
            updatedAt: string;
          };
      };

      // reson8 tools
      type Reson8CodemodeProvider = {
        /** Transcribe a prerecorded audio file via Reson8. */
        transcribePrerecorded(input: Reson8TranscribePrerecordedInput): Promise<Reson8TranscribePrerecordedOutput>;
      };
      declare const reson8: Reson8CodemodeProvider;

      type Reson8TranscribePrerecordedInput = {
        audio: { kind: "arrayBuffer"; arrayBuffer: ArrayBuffer } | { kind: "arrayBufferView"; arrayBufferView: ArrayBufferView } | { kind: "bytes"; bytes: number[] };
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

      // sandbox tools
      type SandboxCodemodeProvider = {
        /** Start a Cloudflare sandbox for the current organisation. */
        startSandbox(input: SandboxStartSandboxInput): Promise<SandboxStartSandboxOutput>;
        /** List Cloudflare sandboxes for the current organisation. */
        listSandboxes(input: SandboxListSandboxesInput): Promise<SandboxListSandboxesOutput>;
        /** Kill a Cloudflare sandbox for the current organisation. */
        killSandbox(input: SandboxKillSandboxInput): Promise<SandboxKillSandboxOutput>;
        /** Execute a command in a Cloudflare sandbox. */
        executeCommand(input: SandboxExecuteCommandInput): Promise<SandboxExecuteCommandOutput>;
      };
      declare const sandbox: SandboxCodemodeProvider;

      type SandboxStartSandboxInput = {
        id: string;
        keepAlive?: boolean;
        sleepAfter?: string | number;
        startupTimeoutMs?: number;
        startupCommand?: string;
      };
      type SandboxStartSandboxOutput = {
        id: string;
        status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
      };
      type SandboxListSandboxesInput = Record<string, unknown>;
      type SandboxListSandboxesOutput = ({
        id: string;
        status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
      })[];
      type SandboxKillSandboxInput = {
        sandboxId: string;
      };
      type SandboxKillSandboxOutput = {
        sandboxId: string;
        killed: true;
      };
      type SandboxExecuteCommandInput = {
        sandboxId: string;
        command: string;
        timeoutMs?: number;
      };
      type SandboxExecuteCommandOutput = {
        ok: true;
        stdout: string;
        stderr: string;
        exitCode: number;
      } | {
        ok: false;
        reason: "command_failed" | "timeout" | "sandbox_terminated" | "sandbox_unavailable" | "internal_error";
        message: string;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        retryable: boolean;
      };

      // telegram tools
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

      // upload tools
      type UploadCodemodeProvider = {
        /** Read the content of a prepared private upload before commit or discard. */
        readPrepared(input: UploadReadPreparedInput): Promise<UploadReadPreparedOutput>;
        /** Commit a prepared private upload so the file persists. */
        commitPrepared(input: UploadCommitPreparedInput): Promise<UploadCommitPreparedOutput>;
        /** Discard a temporary prepared private upload. */
        discardPrepared(input: UploadDiscardPreparedInput): Promise<UploadDiscardPreparedOutput>;
      };
      declare const upload: UploadCodemodeProvider;

      type UploadReadPreparedInput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        encoding?: "utf8" | "base64" | "bytes";
        maxBytes?: number;
      };
      type UploadReadPreparedOutput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        byteLength: number;
        encoding: "utf8";
        text: string;
      } | {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        byteLength: number;
        encoding: "base64";
        base64: string;
      } | {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        byteLength: number;
        encoding: "bytes";
        bytes: Uint8Array;
      };
      type UploadCommitPreparedInput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
      };
      type UploadCommitPreparedOutput = {
        scope: {
            kind: "org";
            orgId: string;
          } | {
            kind: "user";
            userId: string;
          } | {
            kind: "project";
            orgId: string;
            projectId: string;
          };
        uploadId: string;
        provider: string;
        fileKey: string;
        filename: string;
        sizeBytes: number;
        contentType: string;
        kind: "uploaded-file";
      };
      type UploadDiscardPreparedInput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
      };
      type UploadDiscardPreparedOutput = {
        discarded: true;
        uploadId: string;
      };

      // internal tools
      type InternalCodemodeProvider = {
        /** Seed the org workspace with starter files if they do not already exist. */
        filesSeedExecute(input: InternalFilesSeedExecuteInput): Promise<InternalFilesSeedExecuteOutput>;
        /** Configure a project-scoped database-backed workspace filesystem. */
        projectFilesConfigure(input: InternalProjectFilesConfigureInput): Promise<InternalProjectFilesConfigureOutput>;
        /** Seed the default database-backed automation routes. */
        automationsRoutesSeedStarter(input: InternalAutomationsRoutesSeedStarterInput): Promise<InternalAutomationsRoutesSeedStarterOutput>;
        /** Push the bundled static entries into the marketplace. */
        marketplacePush(input: InternalMarketplacePushInput): Promise<InternalMarketplacePushOutput>;
        /** List durable hook queue entries for a runtime fragment. */
        hooksList(input: InternalHooksListInput): Promise<InternalHooksListOutput>;
        /** Get a durable hook queue entry by id. */
        hooksGet(input: InternalHooksGetInput): Promise<InternalHooksGetOutput>;
      };
      declare const internal: InternalCodemodeProvider;

      type InternalFilesSeedExecuteInput = {
        force?: boolean;
      };
      type InternalFilesSeedExecuteOutput = {
        provider: string;
        force: boolean;
        created: string[];
        overwritten: string[];
        skipped: string[];
      };
      type InternalProjectFilesConfigureInput = {
        projectId: string;
      };
      type InternalProjectFilesConfigureOutput = {
        projectId: string;
        provider: "database";
        configured: boolean;
        created: string[];
        skipped: string[];
      };
      type InternalAutomationsRoutesSeedStarterInput = Record<string, unknown>;
      type InternalAutomationsRoutesSeedStarterOutput = {
        created: string[];
        skipped: string[];
      };
      type InternalMarketplacePushInput = Record<string, unknown>;
      type InternalMarketplacePushOutput = {
        publications: ({
            listingId: string;
            slug: string;
            version: string;
            workflowInstanceId: string;
            state: "published";
          } | {
            listingId: string;
            slug: string;
            version: string;
            workflowInstanceId: string;
            state: "requested";
            workflowStatus: "active";
          } | {
            listingId: string;
            slug: string;
            version: string;
            workflowInstanceId: string;
            state: "queued";
            blockedByVersion: string;
          } | {
            listingId: string;
            slug: string;
            version: string;
            workflowInstanceId: string;
            state: "pending";
            workflowStatus: "active" | "waiting" | "paused";
          } | {
            listingId: string;
            slug: string;
            version: string;
            workflowInstanceId: string;
            state: "failed";
            workflowStatus: "errored" | "terminated" | "complete";
            error: {
                  name: string;
                  message: string;
                };
          })[];
      };
      type InternalHooksListInput = {
        fragment: string;
        cursor?: string;
        pageSize?: number;
      };
      type InternalHooksListOutput = {
        configured: boolean;
        hooksEnabled: boolean;
        namespace: string | null;
        items: ({
            id: string;
            hookName: string;
            status: string;
            attempts: number;
            maxAttempts: number;
            lastAttemptAt: string | null;
            nextRetryAt: string | null;
            createdAt: string | null;
            error: string | null;
            payload: unknown;
          })[];
        cursor?: string;
        hasNextPage: boolean;
      };
      type InternalHooksGetInput = {
        fragment: string;
        hookId: string;
      };
      type InternalHooksGetOutput = {
        id: string;
        hookName: string;
        status: string;
        attempts: number;
        maxAttempts: number;
        lastAttemptAt: string | null;
        nextRetryAt: string | null;
        createdAt: string | null;
        error: string | null;
        payload: unknown;
      } | null;

      // Scoped context handles target a selected Backoffice context.
      type BackofficeCodemodeScopedProviders = {
        capabilities: CapabilitiesCodemodeProvider;
        hooks: HooksCodemodeProvider;
        connections: ConnectionsCodemodeProvider;
        store: StoreCodemodeProvider;
        identity: IdentityCodemodeProvider;
        router: RouterCodemodeProvider;
        workflow: WorkflowCodemodeProvider;
        events: EventsCodemodeProvider;
        cloudflare: CloudflareCodemodeProvider;
        web: WebCodemodeProvider;
        api: ApiCodemodeProvider;
        mcp: McpCodemodeProvider;
        otp: OtpCodemodeProvider;
        pi: PiCodemodeProvider;
        resend: ResendCodemodeProvider;
        reson8: Reson8CodemodeProvider;
        sandbox: SandboxCodemodeProvider;
        telegram: TelegramCodemodeProvider;
        upload: UploadCodemodeProvider;
        internal: InternalCodemodeProvider;
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

  test("renders split codemode declarations for every static provider", () => {
    expect(() =>
      createCodemodeTypeFiles({
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

    expect({
      index,
      hasStateFile: files.some((file) => file.path === CODEMODE_STATE_DTS_PATH),
    }).toMatchInlineSnapshot(`
      {
        "hasStateFile": true,
        "index": "/// <reference path="/static/codemode/workflow-authoring.d.ts" />
      /// <reference path="/static/codemode/providers/capabilities.d.ts" />
      /// <reference path="/static/codemode/providers/hooks.d.ts" />
      /// <reference path="/static/codemode/providers/connections.d.ts" />
      /// <reference path="/static/codemode/providers/store.d.ts" />
      /// <reference path="/static/codemode/providers/identity.d.ts" />
      /// <reference path="/static/codemode/providers/router.d.ts" />
      /// <reference path="/static/codemode/providers/workflow.d.ts" />
      /// <reference path="/static/codemode/providers/events.d.ts" />
      /// <reference path="/static/codemode/providers/cloudflare.d.ts" />
      /// <reference path="/static/codemode/providers/web.d.ts" />
      /// <reference path="/static/codemode/providers/api.d.ts" />
      /// <reference path="/static/codemode/providers/mcp.d.ts" />
      /// <reference path="/static/codemode/providers/otp.d.ts" />
      /// <reference path="/static/codemode/providers/pi.d.ts" />
      /// <reference path="/static/codemode/providers/resend.d.ts" />
      /// <reference path="/static/codemode/providers/reson8.d.ts" />
      /// <reference path="/static/codemode/providers/sandbox.d.ts" />
      /// <reference path="/static/codemode/providers/telegram.d.ts" />
      /// <reference path="/static/codemode/providers/upload.d.ts" />

      // Scoped context handles target a selected Backoffice context.
      type BackofficeCodemodeScopedProviders = {
        capabilities: CapabilitiesCodemodeProvider;
        hooks: HooksCodemodeProvider;
        connections: ConnectionsCodemodeProvider;
        store: StoreCodemodeProvider;
        identity: IdentityCodemodeProvider;
        router: RouterCodemodeProvider;
        workflow: WorkflowCodemodeProvider;
        events: EventsCodemodeProvider;
        cloudflare: CloudflareCodemodeProvider;
        web: WebCodemodeProvider;
        api: ApiCodemodeProvider;
        mcp: McpCodemodeProvider;
        otp: OtpCodemodeProvider;
        pi: PiCodemodeProvider;
        resend: ResendCodemodeProvider;
        reson8: Reson8CodemodeProvider;
        sandbox: SandboxCodemodeProvider;
        telegram: TelegramCodemodeProvider;
        upload: UploadCodemodeProvider;
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
      };
      ",
      }
    `);
  });

  test("renders recursive automation route matchers as named codemode types", () => {
    const types = stringifyFamilyByNamespace({
      namespace: "router",
      target: "codemode",
    });

    expect(types).toMatchInlineSnapshot(`
      "// ── Backoffice domain tool providers ───────────────────────────────────

      // router tools
      type RouterCodemodeProvider = {
        /** List database-backed automation routing rules. */
        list(input: RouterListInput): Promise<RouterListOutput>;
        /** Get one database-backed automation routing rule. */
        get(input: RouterGetInput): Promise<RouterGetOutput>;
        /** Create a database-backed automation routing rule. */
        create(input: RouterCreateInput): Promise<RouterCreateOutput>;
        /** Update a database-backed automation routing rule. */
        update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
        /** Idempotently delete a database-backed automation route. */
        delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
        /** Trigger a scheduled automation route immediately without changing its cadence. */
        triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
      };
      declare const router: RouterCodemodeProvider;

      type AutomationRoute = {
        id: string;
        name: string;
        enabled: boolean;
        priority: number;
        trigger: AutomationRouteTrigger;
        action: AutomationRouteAction;
        description?: string | null;
        nextOccurrenceAt: string | null;
      };
      type AutomationRouteTrigger = {
        kind: "event";
        source: string;
        eventType: string;
        matcher: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone: string;
          };
      };
      type AutomationRouteAction = AutomationStartWorkflowAction | AutomationSendWorkflowEventAction | AutomationForwardEventAction;
      type AutomationEventMatcher = {
        actor: {
            participation: "initiator";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "initiator";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "delegation";
            scope: "internal";
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          } | {
            participation: "delegation";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          };
      } | {
        path: string;
        op: "exists";
      } | {
        path: string;
        op: "eq" | "neq" | "startsWith" | "includes";
        value: unknown;
      } | {
        all: AutomationEventMatcher[];
      } | {
        any: AutomationEventMatcher[];
      } | {
        not: AutomationEventMatcher;
      };
      type AutomationStartWorkflowAction = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventAction = {
        kind: "send_workflow_event";
        workflowName: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventAction = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;
      type AutomationRouteScopeTemplate = {
        kind: "system";
      } | {
        kind: "org";
        orgIdTemplate: string;
      } | {
        kind: "project";
        orgIdTemplate: string;
        projectIdTemplate: string;
      } | {
        kind: "user";
        userIdTemplate: string;
      };
      type AutomationWorkflowEventInstanceIdTarget = {
        kind: "instance_id";
        template: string;
      };
      type AutomationWorkflowEventStoredInstanceIdTarget = {
        kind: "stored_instance_id";
        keyTemplate: string;
      };
      type AutomationRouteTriggerInput = {
        kind: "event";
        source: string;
        eventType: string;
        matcher?: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone?: string;
          };
      };
      type AutomationRouteActionInput = AutomationStartWorkflowActionInput | AutomationSendWorkflowEventActionInput | AutomationForwardEventActionInput;
      type AutomationStartWorkflowActionInput = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventActionInput = {
        kind: "send_workflow_event";
        workflowName?: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventActionInput = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type RouterListInput = Record<string, unknown>;
      type RouterListOutput = AutomationRoute[];
      type RouterGetInput = {
        id: string;
      };
      type RouterGetOutput = AutomationRoute | null;
      type RouterCreateInput = {
        id: string;
        name: string;
        enabled?: boolean;
        priority?: number;
        trigger: AutomationRouteTriggerInput;
        action: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterCreateOutput = AutomationRoute;
      type RouterUpdateInput = {
        id: string;
        name?: string;
        enabled?: boolean;
        priority?: number;
        trigger?: AutomationRouteTriggerInput;
        action?: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterUpdateOutput = AutomationRoute | null;
      type RouterDeleteInput = {
        id: string;
      };
      type RouterDeleteOutput = {
        deleted: true;
      };
      type RouterTriggerNowInput = {
        id: string;
      };
      type RouterTriggerNowOutput = {
        accepted: true;
        eventId: string;
      } | null;

      // Scoped context handles target a selected Backoffice context.
      type BackofficeCodemodeScopedProviders = {
        router: RouterCodemodeProvider;
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

  test("renders recursive automation route matchers in generated router provider types", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
    });
    const types = readGeneratedFile(files, "/static/codemode/providers/router.d.ts");

    expect(types).toMatchInlineSnapshot(`
      "// router tools
      type RouterCodemodeProvider = {
        /** List database-backed automation routing rules. */
        list(input: RouterListInput): Promise<RouterListOutput>;
        /** Get one database-backed automation routing rule. */
        get(input: RouterGetInput): Promise<RouterGetOutput>;
        /** Create a database-backed automation routing rule. */
        create(input: RouterCreateInput): Promise<RouterCreateOutput>;
        /** Update a database-backed automation routing rule. */
        update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
        /** Idempotently delete a database-backed automation route. */
        delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
        /** Trigger a scheduled automation route immediately without changing its cadence. */
        triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
      };
      declare const router: RouterCodemodeProvider;

      type AutomationRoute = {
        id: string;
        name: string;
        enabled: boolean;
        priority: number;
        trigger: AutomationRouteTrigger;
        action: AutomationRouteAction;
        description?: string | null;
        nextOccurrenceAt: string | null;
      };
      type AutomationRouteTrigger = {
        kind: "event";
        source: string;
        eventType: string;
        matcher: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone: string;
          };
      };
      type AutomationRouteAction = AutomationStartWorkflowAction | AutomationSendWorkflowEventAction | AutomationForwardEventAction;
      type AutomationEventMatcher = {
        actor: {
            participation: "initiator";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "initiator";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "delegation";
            scope: "internal";
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          } | {
            participation: "delegation";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          };
      } | {
        path: string;
        op: "exists";
      } | {
        path: string;
        op: "eq" | "neq" | "startsWith" | "includes";
        value: unknown;
      } | {
        all: AutomationEventMatcher[];
      } | {
        any: AutomationEventMatcher[];
      } | {
        not: AutomationEventMatcher;
      };
      type AutomationStartWorkflowAction = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventAction = {
        kind: "send_workflow_event";
        workflowName: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventAction = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;
      type AutomationRouteScopeTemplate = {
        kind: "system";
      } | {
        kind: "org";
        orgIdTemplate: string;
      } | {
        kind: "project";
        orgIdTemplate: string;
        projectIdTemplate: string;
      } | {
        kind: "user";
        userIdTemplate: string;
      };
      type AutomationWorkflowEventInstanceIdTarget = {
        kind: "instance_id";
        template: string;
      };
      type AutomationWorkflowEventStoredInstanceIdTarget = {
        kind: "stored_instance_id";
        keyTemplate: string;
      };
      type AutomationRouteTriggerInput = {
        kind: "event";
        source: string;
        eventType: string;
        matcher?: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone?: string;
          };
      };
      type AutomationRouteActionInput = AutomationStartWorkflowActionInput | AutomationSendWorkflowEventActionInput | AutomationForwardEventActionInput;
      type AutomationStartWorkflowActionInput = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventActionInput = {
        kind: "send_workflow_event";
        workflowName?: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventActionInput = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type RouterListInput = Record<string, unknown>;
      type RouterListOutput = AutomationRoute[];
      type RouterGetInput = {
        id: string;
      };
      type RouterGetOutput = AutomationRoute | null;
      type RouterCreateInput = {
        id: string;
        name: string;
        enabled?: boolean;
        priority?: number;
        trigger: AutomationRouteTriggerInput;
        action: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterCreateOutput = AutomationRoute;
      type RouterUpdateInput = {
        id: string;
        name?: string;
        enabled?: boolean;
        priority?: number;
        trigger?: AutomationRouteTriggerInput;
        action?: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterUpdateOutput = AutomationRoute | null;
      type RouterDeleteInput = {
        id: string;
      };
      type RouterDeleteOutput = {
        deleted: true;
      };
      type RouterTriggerNowInput = {
        id: string;
      };
      type RouterTriggerNowOutput = {
        accepted: true;
        eventId: string;
      } | null;
      "
    `);
  });

  test("emits shared recursive matcher declarations before route input and output aliases", () => {
    const types = stringifyFamilyByNamespace({
      namespace: "router",
      target: "codemode",
    });
    const matcherIndex = types.indexOf("type AutomationEventMatcher =");
    const listOutputIndex = types.indexOf("type RouterListOutput =");
    const createInputIndex = types.indexOf("type RouterCreateInput =");
    const updateInputIndex = types.indexOf("type RouterUpdateInput =");

    expect({
      matcherIndex,
      listOutputIndex,
      createInputIndex,
      updateInputIndex,
      types,
    }).toMatchInlineSnapshot(`
        {
          "createInputIndex": 4991,
          "listOutputIndex": 4860,
          "matcherIndex": 1641,
          "types": "// ── Backoffice domain tool providers ───────────────────────────────────

        // router tools
        type RouterCodemodeProvider = {
          /** List database-backed automation routing rules. */
          list(input: RouterListInput): Promise<RouterListOutput>;
          /** Get one database-backed automation routing rule. */
          get(input: RouterGetInput): Promise<RouterGetOutput>;
          /** Create a database-backed automation routing rule. */
          create(input: RouterCreateInput): Promise<RouterCreateOutput>;
          /** Update a database-backed automation routing rule. */
          update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
          /** Idempotently delete a database-backed automation route. */
          delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
          /** Trigger a scheduled automation route immediately without changing its cadence. */
          triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
        };
        declare const router: RouterCodemodeProvider;

        type AutomationRoute = {
          id: string;
          name: string;
          enabled: boolean;
          priority: number;
          trigger: AutomationRouteTrigger;
          action: AutomationRouteAction;
          description?: string | null;
          nextOccurrenceAt: string | null;
        };
        type AutomationRouteTrigger = {
          kind: "event";
          source: string;
          eventType: string;
          matcher: AutomationEventMatcher | null;
        } | {
          kind: "schedule";
          cadence: {
              kind: "once";
              /** ISO 8601 datetime string. */
              at: string;
            } | {
              kind: "cron";
              expression: string;
              timeZone: string;
            };
        };
        type AutomationRouteAction = AutomationStartWorkflowAction | AutomationSendWorkflowEventAction | AutomationForwardEventAction;
        type AutomationEventMatcher = {
          actor: {
              participation: "initiator";
              scope: "internal";
              type?: string;
              id?: string;
            } | {
              participation: "initiator";
              scope: "external";
              source?: string;
              type?: string;
              id?: string;
            } | {
              participation: "principal";
              scope: "internal";
              type?: string;
              id?: string;
            } | {
              participation: "principal";
              scope: "external";
              source?: string;
              type?: string;
              id?: string;
            } | {
              participation: "delegation";
              scope: "internal";
              type?: string;
              id?: string;
              role?: "delegate" | "assistant";
            } | {
              participation: "delegation";
              scope: "external";
              source?: string;
              type?: string;
              id?: string;
              role?: "delegate" | "assistant";
            };
        } | {
          path: string;
          op: "exists";
        } | {
          path: string;
          op: "eq" | "neq" | "startsWith" | "includes";
          value: unknown;
        } | {
          all: AutomationEventMatcher[];
        } | {
          any: AutomationEventMatcher[];
        } | {
          not: AutomationEventMatcher;
        };
        type AutomationStartWorkflowAction = {
          kind: "start_workflow";
          remoteWorkflowName?: string;
          workflowScriptPath: string;
          instanceIdTemplate: string;
        };
        type AutomationSendWorkflowEventAction = {
          kind: "send_workflow_event";
          workflowName: string;
          remoteWorkflowName: string;
          target: AutomationWorkflowEventTarget;
          eventType: string;
          payload?: unknown;
        };
        type AutomationForwardEventAction = {
          kind: "forward_event";
          targetScope: AutomationRouteScopeTemplate;
          idTemplate?: string;
        };
        type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;
        type AutomationRouteScopeTemplate = {
          kind: "system";
        } | {
          kind: "org";
          orgIdTemplate: string;
        } | {
          kind: "project";
          orgIdTemplate: string;
          projectIdTemplate: string;
        } | {
          kind: "user";
          userIdTemplate: string;
        };
        type AutomationWorkflowEventInstanceIdTarget = {
          kind: "instance_id";
          template: string;
        };
        type AutomationWorkflowEventStoredInstanceIdTarget = {
          kind: "stored_instance_id";
          keyTemplate: string;
        };
        type AutomationRouteTriggerInput = {
          kind: "event";
          source: string;
          eventType: string;
          matcher?: AutomationEventMatcher | null;
        } | {
          kind: "schedule";
          cadence: {
              kind: "once";
              /** ISO 8601 datetime string. */
              at: string;
            } | {
              kind: "cron";
              expression: string;
              timeZone?: string;
            };
        };
        type AutomationRouteActionInput = AutomationStartWorkflowActionInput | AutomationSendWorkflowEventActionInput | AutomationForwardEventActionInput;
        type AutomationStartWorkflowActionInput = {
          kind: "start_workflow";
          remoteWorkflowName?: string;
          workflowScriptPath: string;
          instanceIdTemplate: string;
        };
        type AutomationSendWorkflowEventActionInput = {
          kind: "send_workflow_event";
          workflowName?: string;
          remoteWorkflowName: string;
          target: AutomationWorkflowEventTarget;
          eventType: string;
          payload?: unknown;
        };
        type AutomationForwardEventActionInput = {
          kind: "forward_event";
          targetScope: AutomationRouteScopeTemplate;
          idTemplate?: string;
        };
        type RouterListInput = Record<string, unknown>;
        type RouterListOutput = AutomationRoute[];
        type RouterGetInput = {
          id: string;
        };
        type RouterGetOutput = AutomationRoute | null;
        type RouterCreateInput = {
          id: string;
          name: string;
          enabled?: boolean;
          priority?: number;
          trigger: AutomationRouteTriggerInput;
          action: AutomationRouteActionInput;
          description?: string | null;
        };
        type RouterCreateOutput = AutomationRoute;
        type RouterUpdateInput = {
          id: string;
          name?: string;
          enabled?: boolean;
          priority?: number;
          trigger?: AutomationRouteTriggerInput;
          action?: AutomationRouteActionInput;
          description?: string | null;
        };
        type RouterUpdateOutput = AutomationRoute | null;
        type RouterDeleteInput = {
          id: string;
        };
        type RouterDeleteOutput = {
          deleted: true;
        };
        type RouterTriggerNowInput = {
          id: string;
        };
        type RouterTriggerNowOutput = {
          accepted: true;
          eventId: string;
        } | null;

        // Scoped context handles target a selected Backoffice context.
        type BackofficeCodemodeScopedProviders = {
          router: RouterCodemodeProvider;
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
        };",
          "updateInputIndex": 5245,
        }
      `);
  });

  test("dedupes automation route and action declarations in router codemode types", () => {
    const types = stringifyFamilyByNamespace({
      namespace: "router",
      target: "codemode",
    });

    expect(types).toMatchInlineSnapshot(`
      "// ── Backoffice domain tool providers ───────────────────────────────────

      // router tools
      type RouterCodemodeProvider = {
        /** List database-backed automation routing rules. */
        list(input: RouterListInput): Promise<RouterListOutput>;
        /** Get one database-backed automation routing rule. */
        get(input: RouterGetInput): Promise<RouterGetOutput>;
        /** Create a database-backed automation routing rule. */
        create(input: RouterCreateInput): Promise<RouterCreateOutput>;
        /** Update a database-backed automation routing rule. */
        update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
        /** Idempotently delete a database-backed automation route. */
        delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
        /** Trigger a scheduled automation route immediately without changing its cadence. */
        triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
      };
      declare const router: RouterCodemodeProvider;

      type AutomationRoute = {
        id: string;
        name: string;
        enabled: boolean;
        priority: number;
        trigger: AutomationRouteTrigger;
        action: AutomationRouteAction;
        description?: string | null;
        nextOccurrenceAt: string | null;
      };
      type AutomationRouteTrigger = {
        kind: "event";
        source: string;
        eventType: string;
        matcher: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone: string;
          };
      };
      type AutomationRouteAction = AutomationStartWorkflowAction | AutomationSendWorkflowEventAction | AutomationForwardEventAction;
      type AutomationEventMatcher = {
        actor: {
            participation: "initiator";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "initiator";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "internal";
            type?: string;
            id?: string;
          } | {
            participation: "principal";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          } | {
            participation: "delegation";
            scope: "internal";
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          } | {
            participation: "delegation";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          };
      } | {
        path: string;
        op: "exists";
      } | {
        path: string;
        op: "eq" | "neq" | "startsWith" | "includes";
        value: unknown;
      } | {
        all: AutomationEventMatcher[];
      } | {
        any: AutomationEventMatcher[];
      } | {
        not: AutomationEventMatcher;
      };
      type AutomationStartWorkflowAction = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventAction = {
        kind: "send_workflow_event";
        workflowName: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventAction = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type AutomationWorkflowEventTarget = AutomationWorkflowEventInstanceIdTarget | AutomationWorkflowEventStoredInstanceIdTarget;
      type AutomationRouteScopeTemplate = {
        kind: "system";
      } | {
        kind: "org";
        orgIdTemplate: string;
      } | {
        kind: "project";
        orgIdTemplate: string;
        projectIdTemplate: string;
      } | {
        kind: "user";
        userIdTemplate: string;
      };
      type AutomationWorkflowEventInstanceIdTarget = {
        kind: "instance_id";
        template: string;
      };
      type AutomationWorkflowEventStoredInstanceIdTarget = {
        kind: "stored_instance_id";
        keyTemplate: string;
      };
      type AutomationRouteTriggerInput = {
        kind: "event";
        source: string;
        eventType: string;
        matcher?: AutomationEventMatcher | null;
      } | {
        kind: "schedule";
        cadence: {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          } | {
            kind: "cron";
            expression: string;
            timeZone?: string;
          };
      };
      type AutomationRouteActionInput = AutomationStartWorkflowActionInput | AutomationSendWorkflowEventActionInput | AutomationForwardEventActionInput;
      type AutomationStartWorkflowActionInput = {
        kind: "start_workflow";
        remoteWorkflowName?: string;
        workflowScriptPath: string;
        instanceIdTemplate: string;
      };
      type AutomationSendWorkflowEventActionInput = {
        kind: "send_workflow_event";
        workflowName?: string;
        remoteWorkflowName: string;
        target: AutomationWorkflowEventTarget;
        eventType: string;
        payload?: unknown;
      };
      type AutomationForwardEventActionInput = {
        kind: "forward_event";
        targetScope: AutomationRouteScopeTemplate;
        idTemplate?: string;
      };
      type RouterListInput = Record<string, unknown>;
      type RouterListOutput = AutomationRoute[];
      type RouterGetInput = {
        id: string;
      };
      type RouterGetOutput = AutomationRoute | null;
      type RouterCreateInput = {
        id: string;
        name: string;
        enabled?: boolean;
        priority?: number;
        trigger: AutomationRouteTriggerInput;
        action: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterCreateOutput = AutomationRoute;
      type RouterUpdateInput = {
        id: string;
        name?: string;
        enabled?: boolean;
        priority?: number;
        trigger?: AutomationRouteTriggerInput;
        action?: AutomationRouteActionInput;
        description?: string | null;
      };
      type RouterUpdateOutput = AutomationRoute | null;
      type RouterDeleteInput = {
        id: string;
      };
      type RouterDeleteOutput = {
        deleted: true;
      };
      type RouterTriggerNowInput = {
        id: string;
      };
      type RouterTriggerNowOutput = {
        accepted: true;
        eventId: string;
      } | null;

      // Scoped context handles target a selected Backoffice context.
      type BackofficeCodemodeScopedProviders = {
        router: RouterCodemodeProvider;
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

  test("renders codemode provider files from the default dynamic codemode family list", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: STATE_TYPES,
    });
    const capabilitiesTypes = readGeneratedFile(
      files,
      "/static/codemode/providers/capabilities.d.ts",
    );
    const connectionsTypes = readGeneratedFile(
      files,
      "/static/codemode/providers/connections.d.ts",
    );
    const workflowTypes = readGeneratedFile(files, "/static/codemode/providers/workflow.d.ts");
    const eventTypes = readGeneratedFile(files, "/static/codemode/providers/events.d.ts");
    const otpTypes = readGeneratedFile(files, "/static/codemode/providers/otp.d.ts");
    const webTypes = readGeneratedFile(files, "/static/codemode/providers/web.d.ts");

    expect({
      capabilitiesTypes,
      connectionsTypes,
      eventTypes,
      otpTypes,
      piTypes: readGeneratedFile(files, "/static/codemode/providers/pi.d.ts"),
      storeTypes: readGeneratedFile(files, "/static/codemode/providers/store.d.ts"),
      telegramTypes: readGeneratedFile(files, "/static/codemode/providers/telegram.d.ts"),
      webTypes,
      workflowTypes,
    }).toMatchInlineSnapshot(`
      {
        "capabilitiesTypes": "// capabilities tools
      type CapabilitiesCodemodeProvider = {
        /** List Backoffice capabilities and availability/configuration status. */
        list(input: CapabilitiesListInput): Promise<CapabilitiesListOutput>;
      };
      declare const capabilities: CapabilitiesCodemodeProvider;

      type CapabilitiesListInput = Record<string, unknown>;
      type CapabilitiesListOutput = ({
        id: string;
        label: string;
        kind: "connection" | "system";
        available: boolean;
        configured: boolean;
        healthy?: boolean;
        reason?: string;
      })[];
      ",
        "connectionsTypes": "// connections tools
      type ConnectionsCodemodeProvider = {
        /** List configurable Backoffice connections and their configuration status. */
        list(input: ConnectionsListInput): Promise<ConnectionsListOutput>;
        /** Get one Backoffice connection status with masked configuration values. */
        get(input: ConnectionsGetInput): Promise<ConnectionsGetOutput>;
        /** Show human steps for configuring a Backoffice connection. */
        setup(input: ConnectionsSetupInput): Promise<ConnectionsSetupOutput>;
        /** Show the accepted configuration fields for a Backoffice connection. */
        schema(input: ConnectionsSchemaInput): Promise<ConnectionsSchemaOutput>;
        /** Verify a Backoffice connection without changing its configuration. */
        verify(input: ConnectionsVerifyInput): Promise<ConnectionsVerifyOutput>;
        /** Reset a Backoffice connection configuration. Requires --confirm <id>. */
        reset(input: ConnectionsResetInput): Promise<ConnectionsResetOutput>;
        /** Configure a Backoffice connection. Secrets are accepted in input but masked in output. */
        configure(input: ConnectionsConfigureInput): Promise<ConnectionsConfigureOutput>;
      };
      declare const connections: ConnectionsCodemodeProvider;

      type ConnectionsListInput = Record<string, unknown>;
      type ConnectionsListOutput = ({
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        hookScopes: string[];
        runtimeToolNamespaces: string[];
        automationEvents: string[];
        missing?: string[];
      })[];
      type ConnectionsGetInput = {
        id: string;
      };
      type ConnectionsGetOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification?: {
            ok: boolean;
            message: string;
          };
      };
      type ConnectionsSetupInput = {
        id: string;
      };
      type ConnectionsSetupOutput = {
        id: string;
        label: string;
        overview: string;
        manualSteps: {
            id: string;
            title: string;
            instructions: string;
            expectedUserInput?: string[];
          }[];
        fields: {
            name: string;
            required?: boolean;
            secret?: boolean;
            description?: string;
          }[];
        verify?: {
            tool: string;
            description: string;
          };
        configureExample: string;
      };
      type ConnectionsSchemaInput = {
        id: string;
      };
      type ConnectionsSchemaOutput = {
        id: string;
        label: string;
        fields: {
            name: string;
            required?: boolean;
            secret?: boolean;
            description?: string;
          }[];
      };
      type ConnectionsVerifyInput = {
        id: string;
      };
      type ConnectionsVerifyOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification: {
            ok: boolean;
            message: string;
          };
      };
      type ConnectionsResetInput = {
        id: string;
        confirm: string;
      };
      type ConnectionsResetOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification?: {
            ok: boolean;
            message: string;
          };
      };
      type ConnectionsConfigureInput = {
        id: string;
        payload: unknown;
        origin?: string;
      };
      type ConnectionsConfigureOutput = {
        id: string;
        label: string;
        kind: "connection" | "system";
        configured: boolean;
        config?: {
            [key: string]: unknown;
          };
        missing?: string[];
        nextSteps?: string[];
        verification?: {
            ok: boolean;
            message: string;
          };
      };
      ",
        "eventTypes": "// events tools
      type EventsCodemodeProvider = {
        /** Fire an automation event for the current context or a selected target scope. */
        fire(input: EventsFireInput): Promise<EventsFireOutput>;
        /** List known automation event source/type pairs from the Backoffice capability registry. */
        catalogList(input: EventsCatalogListInput): Promise<EventsCatalogListOutput>;
        /** Get one automation event descriptor and its JSON schemas. */
        catalogGet(input: EventsCatalogGetInput): Promise<EventsCatalogGetOutput>;
        /** Create a scoped dynamic automation event definition with optional JSON schemas. */
        catalogCreate(input: EventsCatalogCreateInput): Promise<EventsCatalogCreateOutput>;
      };
      declare const events: EventsCodemodeProvider;

      type EventsFireInput = {
        eventType: string;
        source?: string;
        subjectUserId?: string;
        payload?: {
            [key: string]: unknown;
          };
        targetScope?: {
            kind: "system";
          } | {
            kind: "org";
            orgId: string;
          } | {
            kind: "user";
            userId: string;
          } | {
            kind: "project";
            orgId: string;
            projectId: string;
          };
      };
      type EventsFireOutput = {
        accepted: boolean;
        eventId: string;
        scope: {
            kind: "system";
          } | {
            kind: "org";
            orgId: string;
          } | {
            kind: "user";
            userId: string;
          } | {
            kind: "project";
            orgId: string;
            projectId: string;
          };
        source: string;
        eventType: string;
      };
      type EventsCatalogListInput = Record<string, unknown>;
      type EventsCatalogListOutput = {
        source: string;
        eventType: string;
        label: string;
        description?: string;
        capabilityId: string;
        example?: unknown;
      }[];
      type EventsCatalogGetInput = {
        source: string;
        eventType: string;
      };
      type EventsCatalogGetOutput = {
        source: string;
        eventType: string;
        label: string;
        description?: string;
        capabilityId: string;
        payloadSchema?: {
            [key: string]: unknown;
          };
        actorSchema?: {
            [key: string]: unknown;
          };
        subjectSchema?: {
            [key: string]: unknown;
          };
        example?: unknown;
      } | null;
      type EventsCatalogCreateInput = {
        source: string;
        eventType: string;
        label: string;
        description?: string | null;
        payloadSchema?: {
            [key: string]: unknown;
          } | null;
        actorSchema?: {
            [key: string]: unknown;
          } | null;
        subjectSchema?: {
            [key: string]: unknown;
          } | null;
        example?: unknown | null;
        enabled?: boolean;
      };
      type EventsCatalogCreateOutput = {
        id: string;
        source: string;
        eventType: string;
        label: string;
        description?: string | null;
        payloadSchema?: {
            [key: string]: unknown;
          } | null;
        actorSchema?: {
            [key: string]: unknown;
          } | null;
        subjectSchema?: {
            [key: string]: unknown;
          } | null;
        example?: unknown | null;
        enabled: boolean;
        capabilityId: string;
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      };
      ",
        "otpTypes": "// otp tools
      type OtpCodemodeProvider = {
        /** Create a short-lived identity claim URL for the trusted external initiator. */
        createIdentityClaim(input: OtpCreateIdentityClaimInput): Promise<OtpCreateIdentityClaimOutput>;
      };
      declare const otp: OtpCodemodeProvider;

      type OtpCreateIdentityClaimInput = {
        ttlMinutes?: number;
      };
      type OtpCreateIdentityClaimOutput = {
        url: string;
        otpId: string;
        externalId: string;
        code: string;
        actor: {
            scope: "external";
            source: string;
            type: string;
            id: string;
          };
        type?: string;
        expiresAt?: string;
      };
      ",
        "piTypes": "// pi tools
      type PiCodemodeProvider = {
        /** Create a new Pi session. */
        createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
        /** Retrieve a Pi session by id. */
        getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
        /** List Pi sessions ordered by creation time. */
        listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
        /** Send one prompt command through a Pi active session and return the settled result. */
        runTurn(input: PiRunTurnInput): Promise<PiRunTurnOutput>;
      };
      declare const pi: PiCodemodeProvider;

      type PiCreateSessionInput = {
        model?: {
            provider: "openai" | "anthropic" | "gemini";
            name: string;
          };
        name?: string;
        systemMessage?: string;
        metadata?: {
            [key: string]: unknown;
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiCreateSessionOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiGetSessionInput = {
        sessionId: string;
        events?: boolean;
        trace?: boolean;
        turns?: boolean;
      };
      type PiGetSessionOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        workflow: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        agent: {
            state: {
                  messages: unknown[];
                  errorMessage?: string;
                };
            completedStepKeys: string[];
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiListSessionsInput = {
        limit?: number;
      };
      type PiListSessionsOutput = ({
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      })[];
      type PiRunTurnInput = {
        sessionId: string;
        text: string;
      };
      type PiRunTurnOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        workflow: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        agent: {
            state: {
                  messages: unknown[];
                  errorMessage?: string;
                };
            completedStepKeys: string[];
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
        assistantText: string;
        commandStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        stream: unknown[];
        terminalState: {
            messages: unknown[];
            errorMessage?: string;
          };
      };
      ",
        "storeTypes": "// store tools
      type StoreCodemodeProvider = {
        /** Get an automation store entry by key. */
        get(input: StoreGetInput): Promise<StoreGetOutput>;
        /** Create or update an automation store entry. */
        set(input: StoreSetInput): Promise<StoreSetOutput>;
        /** Delete an automation store entry by key. */
        delete(input: StoreDeleteInput): Promise<StoreDeleteOutput>;
        /** List automation store entries, optionally filtered by key prefix. */
        list(input: StoreListInput): Promise<StoreListOutput>;
      };
      declare const store: StoreCodemodeProvider;

      type StoreGetInput = {
        key: string;
      };
      type StoreGetOutput = {
        id?: string;
        key: string;
        value: string;
        description?: string | null;
        category: string[];
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      } | null;
      type StoreSetInput = {
        key: string;
        value: string;
        description?: string | null;
        category?: string[];
        verification?: {
            type: "json-schema";
            schema: unknown;
          }[];
      };
      type StoreSetOutput = {
        id: string;
        key: string;
        value: string;
        description?: string | null;
        category: string[];
      };
      type StoreDeleteInput = {
        key: string;
      };
      type StoreDeleteOutput = {
        ok: true;
        key: string;
      } | null;
      type StoreListInput = {
        prefix?: string;
        limit?: number;
      };
      type StoreListOutput = ({
        id?: string;
        key: string;
        value: string;
        description?: string | null;
        category: string[];
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      })[];
      ",
        "telegramTypes": "// telegram tools
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
      ",
        "webTypes": "// web tools
      type WebCodemodeProvider = {
        /** Extract page content or Markdown from a URL or HTML. */
        extract(input: WebExtractInput): Promise<WebExtractOutput>;
      };
      declare const web: WebCodemodeProvider;

      type WebExtractInput = {
        action: "content";
        input: {
            url?: string;
            html?: string;
            [key: string]: unknown;
          };
      } | {
        action: "markdown";
        input: {
            url?: string;
            html?: string;
            [key: string]: unknown;
          };
      };
      type WebExtractOutput = {
        action: "content";
        result: string;
      } | {
        action: "markdown";
        result: string;
      };
      ",
        "workflowTypes": "// workflow tools
      type WorkflowCodemodeProvider = {
        /** List registered durable workflows. */
        listWorkflows(input: WorkflowListWorkflowsInput): Promise<WorkflowListWorkflowsOutput>;
        /** Create a durable workflow instance. */
        createInstance(input: WorkflowCreateInstanceInput): Promise<WorkflowCreateInstanceOutput>;
        /** List durable workflow instances. */
        listInstances(input: WorkflowListInstancesInput): Promise<WorkflowListInstancesOutput>;
        /** Get durable workflow instance details. */
        getInstance(input: WorkflowGetInstanceInput): Promise<WorkflowGetInstanceOutput>;
        /** Get durable workflow step, event, and emission history. */
        getHistory(input: WorkflowGetHistoryInput): Promise<WorkflowGetHistoryOutput>;
        /** Send an event to a waiting durable workflow instance. */
        sendEvent(input: WorkflowSendEventInput): Promise<WorkflowSendEventOutput>;
        /** Retry a durable workflow instance step. */
        retryInstance(input: WorkflowRetryInstanceInput): Promise<WorkflowRetryInstanceOutput>;
      };
      declare const workflow: WorkflowCodemodeProvider;

      type WorkflowListWorkflowsInput = Record<string, unknown>;
      type WorkflowListWorkflowsOutput = {
        workflows: {
            name: string;
          }[];
      };
      type WorkflowCreateInstanceInput = {
        workflowName: string;
        remoteWorkflowName?: string;
        instanceId?: string;
        params?: unknown;
      };
      type WorkflowCreateInstanceOutput = {
        workflowName: string;
        instanceId: string;
      };
      type WorkflowListInstancesInput = {
        workflowName: string;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        remoteWorkflowName?: string;
        pageSize?: number;
        cursor?: string;
      };
      type WorkflowListInstancesOutput = {
        instances: ({
            id: string;
            details: {
                  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
                  error?: {
                          name: string;
                          message: string;
                        };
                  output?: unknown;
                };
            createdAt: string;
          })[];
        nextCursor?: string;
        hasNextPage: boolean;
      };
      type WorkflowGetInstanceInput = {
        workflowName: string;
        instanceId: string;
      };
      type WorkflowGetInstanceOutput = {
        id: string;
        details: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        meta: {
            [key: string]: unknown;
          };
      };
      type WorkflowGetHistoryInput = {
        workflowName: string;
        instanceId: string;
      };
      type WorkflowGetHistoryOutput = {
        steps: unknown[];
        events: unknown[];
        emissions: unknown[];
      };
      type WorkflowSendEventInput = {
        workflowName: string;
        instanceId: string;
        type: string;
        payload?: unknown;
      };
      type WorkflowSendEventOutput = unknown;
      type WorkflowRetryInstanceInput = {
        workflowName: string;
        instanceId: string;
        stepKey?: string;
        delayMs?: number;
        reason?: string;
      };
      type WorkflowRetryInstanceOutput = {
        accepted: true;
        instance: {
            id: string;
            details: {
                  status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
                  error?: {
                          name: string;
                          message: string;
                        };
                  output?: unknown;
                };
          };
        retry: {
            stepKey: string;
            attempts: number;
            maxAttempts: number;
            scheduledAt: string;
          };
      };
      ",
      }
    `);
  });

  test("renders scoped context handles", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: STATE_TYPES,
    });
    const types = readGeneratedFile(files, CODEMODE_SYSTEM_DTS_PATH);

    expect(types).toMatchInlineSnapshot(`
      "/// <reference path="/static/codemode/workflow-authoring.d.ts" />
      /// <reference path="/static/codemode/providers/capabilities.d.ts" />
      /// <reference path="/static/codemode/providers/hooks.d.ts" />
      /// <reference path="/static/codemode/providers/connections.d.ts" />
      /// <reference path="/static/codemode/providers/store.d.ts" />
      /// <reference path="/static/codemode/providers/identity.d.ts" />
      /// <reference path="/static/codemode/providers/router.d.ts" />
      /// <reference path="/static/codemode/providers/workflow.d.ts" />
      /// <reference path="/static/codemode/providers/events.d.ts" />
      /// <reference path="/static/codemode/providers/cloudflare.d.ts" />
      /// <reference path="/static/codemode/providers/web.d.ts" />
      /// <reference path="/static/codemode/providers/api.d.ts" />
      /// <reference path="/static/codemode/providers/mcp.d.ts" />
      /// <reference path="/static/codemode/providers/otp.d.ts" />
      /// <reference path="/static/codemode/providers/pi.d.ts" />
      /// <reference path="/static/codemode/providers/resend.d.ts" />
      /// <reference path="/static/codemode/providers/reson8.d.ts" />
      /// <reference path="/static/codemode/providers/sandbox.d.ts" />
      /// <reference path="/static/codemode/providers/telegram.d.ts" />
      /// <reference path="/static/codemode/providers/upload.d.ts" />

      // Scoped context handles target a selected Backoffice context.
      type BackofficeCodemodeScopedProviders = {
        capabilities: CapabilitiesCodemodeProvider;
        hooks: HooksCodemodeProvider;
        connections: ConnectionsCodemodeProvider;
        store: StoreCodemodeProvider;
        identity: IdentityCodemodeProvider;
        router: RouterCodemodeProvider;
        workflow: WorkflowCodemodeProvider;
        events: EventsCodemodeProvider;
        cloudflare: CloudflareCodemodeProvider;
        web: WebCodemodeProvider;
        api: ApiCodemodeProvider;
        mcp: McpCodemodeProvider;
        otp: OtpCodemodeProvider;
        pi: PiCodemodeProvider;
        resend: ResendCodemodeProvider;
        reson8: Reson8CodemodeProvider;
        sandbox: SandboxCodemodeProvider;
        telegram: TelegramCodemodeProvider;
        upload: UploadCodemodeProvider;
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
      };
      "
    `);
  });

  test("renders capability provider types from the start", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
    });

    expect({
      pi: readGeneratedFile(files, "/static/codemode/providers/pi.d.ts"),
      sandbox: readGeneratedFile(files, "/static/codemode/providers/sandbox.d.ts"),
    }).toMatchInlineSnapshot(`
      {
        "pi": "// pi tools
      type PiCodemodeProvider = {
        /** Create a new Pi session. */
        createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
        /** Retrieve a Pi session by id. */
        getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
        /** List Pi sessions ordered by creation time. */
        listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
        /** Send one prompt command through a Pi active session and return the settled result. */
        runTurn(input: PiRunTurnInput): Promise<PiRunTurnOutput>;
      };
      declare const pi: PiCodemodeProvider;

      type PiCreateSessionInput = {
        model?: {
            provider: "openai" | "anthropic" | "gemini";
            name: string;
          };
        name?: string;
        systemMessage?: string;
        metadata?: {
            [key: string]: unknown;
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiCreateSessionOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiGetSessionInput = {
        sessionId: string;
        events?: boolean;
        trace?: boolean;
        turns?: boolean;
      };
      type PiGetSessionOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        workflow: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        agent: {
            state: {
                  messages: unknown[];
                  errorMessage?: string;
                };
            completedStepKeys: string[];
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiListSessionsInput = {
        limit?: number;
      };
      type PiListSessionsOutput = ({
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      })[];
      type PiRunTurnInput = {
        sessionId: string;
        text: string;
      };
      type PiRunTurnOutput = {
        id: string;
        name: string | null;
        status?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        metadata: {
            [key: string]: unknown;
          } | null;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        workflow: {
            status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
            error?: {
                  name: string;
                  message: string;
                };
            output?: unknown;
          };
        agent: {
            state: {
                  messages: unknown[];
                  errorMessage?: string;
                };
            completedStepKeys: string[];
          };
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
        assistantText: string;
        commandStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        stream: unknown[];
        terminalState: {
            messages: unknown[];
            errorMessage?: string;
          };
      };
      ",
        "sandbox": "// sandbox tools
      type SandboxCodemodeProvider = {
        /** Start a Cloudflare sandbox for the current organisation. */
        startSandbox(input: SandboxStartSandboxInput): Promise<SandboxStartSandboxOutput>;
        /** List Cloudflare sandboxes for the current organisation. */
        listSandboxes(input: SandboxListSandboxesInput): Promise<SandboxListSandboxesOutput>;
        /** Kill a Cloudflare sandbox for the current organisation. */
        killSandbox(input: SandboxKillSandboxInput): Promise<SandboxKillSandboxOutput>;
        /** Execute a command in a Cloudflare sandbox. */
        executeCommand(input: SandboxExecuteCommandInput): Promise<SandboxExecuteCommandOutput>;
      };
      declare const sandbox: SandboxCodemodeProvider;

      type SandboxStartSandboxInput = {
        id: string;
        keepAlive?: boolean;
        sleepAfter?: string | number;
        startupTimeoutMs?: number;
        startupCommand?: string;
      };
      type SandboxStartSandboxOutput = {
        id: string;
        status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
      };
      type SandboxListSandboxesInput = Record<string, unknown>;
      type SandboxListSandboxesOutput = ({
        id: string;
        status: "requested" | "starting" | "running" | "stopping" | "stopped" | "error";
      })[];
      type SandboxKillSandboxInput = {
        sandboxId: string;
      };
      type SandboxKillSandboxOutput = {
        sandboxId: string;
        killed: true;
      };
      type SandboxExecuteCommandInput = {
        sandboxId: string;
        command: string;
        timeoutMs?: number;
      };
      type SandboxExecuteCommandOutput = {
        ok: true;
        stdout: string;
        stderr: string;
        exitCode: number;
      } | {
        ok: false;
        reason: "command_failed" | "timeout" | "sandbox_terminated" | "sandbox_unavailable" | "internal_error";
        message: string;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        retryable: boolean;
      };
      ",
      }
    `);
  });

  test("renders prepared Upload lifecycle provider types from the start", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
      stateTypes: "declare const state: unknown;",
    });
    const types = readGeneratedFile(files, "/static/codemode/providers/upload.d.ts");

    expect(types).toMatchInlineSnapshot(`
      "// upload tools
      type UploadCodemodeProvider = {
        /** Read the content of a prepared private upload before commit or discard. */
        readPrepared(input: UploadReadPreparedInput): Promise<UploadReadPreparedOutput>;
        /** Commit a prepared private upload so the file persists. */
        commitPrepared(input: UploadCommitPreparedInput): Promise<UploadCommitPreparedOutput>;
        /** Discard a temporary prepared private upload. */
        discardPrepared(input: UploadDiscardPreparedInput): Promise<UploadDiscardPreparedOutput>;
      };
      declare const upload: UploadCodemodeProvider;

      type UploadReadPreparedInput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        encoding?: "utf8" | "base64" | "bytes";
        maxBytes?: number;
      };
      type UploadReadPreparedOutput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        byteLength: number;
        encoding: "utf8";
        text: string;
      } | {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        byteLength: number;
        encoding: "base64";
        base64: string;
      } | {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
        byteLength: number;
        encoding: "bytes";
        bytes: Uint8Array;
      };
      type UploadCommitPreparedInput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
      };
      type UploadCommitPreparedOutput = {
        scope: {
            kind: "org";
            orgId: string;
          } | {
            kind: "user";
            userId: string;
          } | {
            kind: "project";
            orgId: string;
            projectId: string;
          };
        uploadId: string;
        provider: string;
        fileKey: string;
        filename: string;
        sizeBytes: number;
        contentType: string;
        kind: "uploaded-file";
      };
      type UploadDiscardPreparedInput = {
        file: {
            kind: "prepared-upload";
            scope: {
                  kind: "org";
                  orgId: string;
                } | {
                  kind: "user";
                  userId: string;
                } | {
                  kind: "project";
                  orgId: string;
                  projectId: string;
                };
            uploadId: string;
            provider: string;
            fileKey: string;
            filename: string;
            sizeBytes: number;
            contentType: string;
            /** ISO 8601 datetime string. */
            expiresAt: string;
          };
      };
      type UploadDiscardPreparedOutput = {
        discarded: true;
        uploadId: string;
      };
      "
    `);
  });

  test("renders installed MCP providers with dash-safe server slugs", () => {
    const files = createCodemodeTypeFiles({
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
    const types = readGeneratedFile(files, "/static/codemode/sources/mcp_cloudflare_mcp.d.ts");

    expect(types).toMatchInlineSnapshot(`
      "// mcp_cloudflare_mcp tools
      type McpCloudflareMcpCodemodeProvider = {
        /** Search docs. MCP server: cloudflare-mcp; tool: search-docs. */
        search_docs(input: McpCloudflareMcpSearchDocsInput): Promise<McpCloudflareMcpSearchDocsOutput>;
      };
      declare const mcp_cloudflare_mcp: McpCloudflareMcpCodemodeProvider;

      type McpCloudflareMcpSearchDocsInput = {
        query: string;
      };
      type McpCloudflareMcpSearchDocsOutput = Record<string, unknown>;
      "
    `);
  });
});
