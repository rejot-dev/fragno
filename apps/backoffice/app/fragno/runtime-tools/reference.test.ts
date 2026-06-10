import { describe, expect, test } from "vitest";

import { createCodemodeTypes } from "@/fragno/codemode/state-prompt";

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

      declare const telegram: {
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

  test("renders codemode prompt types from the pi codemode target family list", () => {
    const types = createCodemodeTypes({ families: runtimeToolFamilies });
    const domainProviderTypes = types.slice(
      types.indexOf("// ── Backoffice domain tool providers"),
    );

    expect(domainProviderTypes).toContain("declare const store");
    expect(domainProviderTypes).toContain("declare const workflow");
    expect(domainProviderTypes).toContain("createInstance(input: WorkflowCreateInstanceInput)");
    expect(domainProviderTypes).toContain("getInstance(input: WorkflowGetInstanceInput)");
    expect(domainProviderTypes).toContain("retryInstance(input: WorkflowRetryInstanceInput)");
    expect(domainProviderTypes).toContain("declare const otp");
    expect(domainProviderTypes).toContain("declare const pi");
    expect(domainProviderTypes).toContain("declare const telegram");
  });
});
