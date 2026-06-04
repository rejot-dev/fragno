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
import {
  automationRuntimeToolFamilies,
  bashRuntimeToolFamilies,
  piCodemodeRuntimeToolFamilies,
} from "./tool-families";

const summarizeFamilyReference = (family: (typeof bashRuntimeToolFamilies)[number]) => {
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
  const family = bashRuntimeToolFamilies.find((candidate) => candidate.namespace === namespace);
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
      namespace: "automations",
      tools: [
        {
          id: "automations.identity.lookup-binding",
          namespace: "automations",
          codemodeProvider: "automations",
          codemodeTool: "lookupBinding",
          inputType: "AutomationsLookupBindingInput",
          outputType: "AutomationsLookupBindingOutput",
          bashCommand: "automations.identity.lookup-binding",
          bashOptions: ["source", "key"],
        },
        {
          id: "automations.identity.bind-actor",
          namespace: "automations",
          codemodeProvider: "automations",
          codemodeTool: "bindActor",
          inputType: "AutomationsBindActorInput",
          outputType: "AutomationsBindActorOutput",
          bashCommand: "automations.identity.bind-actor",
          bashOptions: ["source", "key", "value", "description"],
        },
        {
          id: "scripts.run",
          namespace: "automations",
          codemodeProvider: "automations",
          codemodeTool: "runScript",
          inputType: "AutomationsRunScriptInput",
          outputType: "AutomationsRunScriptOutput",
          bashCommand: "scripts.run",
          bashOptions: ["script", "event"],
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
          bashOptions: ["source", "external-actor-id", "ttl-minutes"],
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
    expect(
      renderCodemodeProviderTypes(
        createRuntimeToolReferences({ families: automationRuntimeToolFamilies }),
      ),
    ).toMatchInlineSnapshot(`
      "// ── Backoffice domain tool providers ───────────────────────────────────

      // automations tools
      type AutomationsLookupBindingInput = {
        source: string;
        key: string;
      };
      type AutomationsLookupBindingOutput = {
        id?: string;
        source: string;
        key: string;
        value: string;
        description?: string | null;
        status: string;
        /** ISO 8601 datetime string. */
        linkedAt?: string;
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      } | null;
      type AutomationsBindActorInput = {
        source: string;
        key: string;
        value: string;
        description?: string;
      };
      type AutomationsBindActorOutput = {
        id?: string;
        source: string;
        key: string;
        value: string;
        description?: string | null;
        status: string;
        /** ISO 8601 datetime string. */
        linkedAt?: string;
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      };

      declare const automations: {
        /** Lookup a linked automation identity binding by source and key. */
        lookupBinding(input: AutomationsLookupBindingInput): Promise<AutomationsLookupBindingOutput>;
        /** Create or update an automation identity binding. */
        bindActor(input: AutomationsBindActorInput): Promise<AutomationsBindActorOutput>;
      };

      // event tools
      type EventEmitInput = {
        eventType: string;
        source?: string;
        externalActorId?: string;
        actorType?: string;
        subjectUserId?: string;
        payload?: {
            [key: string]: unknown;
          };
      };
      type EventEmitOutput = {
        accepted: boolean;
        eventId: string;
        orgId?: string;
        source: string;
        eventType: string;
      };

      declare const event: {
        /** Emit another automation event for the current organisation. */
        emit(input: EventEmitInput): Promise<EventEmitOutput>;
      };

      // otp tools
      type OtpCreateIdentityClaimInput = {
        source: string;
        externalActorId: string;
        ttlMinutes?: number;
      };
      type OtpCreateIdentityClaimOutput = {
        url: string;
        externalId: string;
        code: string;
        type?: string;
        expiresAt?: string;
      };

      declare const otp: {
        /** Create a short-lived identity claim URL for an external actor. */
        createIdentityClaim(input: OtpCreateIdentityClaimInput): Promise<OtpCreateIdentityClaimOutput>;
      };

      // pi tools
      type PiCreateSessionInput = {
        agent: string;
        name?: string;
        systemMessage?: string;
        metadata?: unknown;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiCreateSessionOutput = {
        id: string;
        name: string | null;
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        agent: string;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        metadata?: unknown;
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
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        agentName: string;
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
            events: unknown[];
          };
        metadata?: unknown;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiListSessionsInput = {
        limit?: number;
      };
      type PiListSessionsOutput = ({
        id: string;
        name: string | null;
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        agent: string;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        metadata?: unknown;
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
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        agentName: string;
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
            events: unknown[];
          };
        metadata?: unknown;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
        assistantText: string;
        commandStatus?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        messageStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        stream: unknown[];
        terminalState: {
            messages: unknown[];
            errorMessage?: string;
          };
      };

      declare const pi: {
        /** Create a new Pi session. */
        createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
        /** Retrieve a Pi session by id. */
        getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
        /** List Pi sessions ordered by creation time. */
        listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
        /** Send one prompt command through a Pi active session and return the settled result. */
        runTurn(input: PiRunTurnInput): Promise<PiRunTurnOutput>;
      };

      // resend tools
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

      declare const resend: {
        /** Load a Resend thread with a page of messages and a Markdown snapshot. */
        getThread(input: ResendGetThreadInput): Promise<ResendGetThreadOutput>;
        /** List Resend email threads. */
        listThreads(input: ResendListThreadsInput): Promise<ResendListThreadsOutput>;
        /** Send a text reply into an existing Resend thread. */
        replyToThread(input: ResendReplyToThreadInput): Promise<ResendReplyToThreadOutput>;
      };

      // reson8 tools
      type Reson8TranscribePrerecordedInput = {
        inputPath?: string;
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

      declare const reson8: {
        /** Transcribe a prerecorded audio file via Reson8. */
        transcribePrerecorded(input: Reson8TranscribePrerecordedInput): Promise<Reson8TranscribePrerecordedOutput>;
      };

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

  test("renders codemode prompt types from the pi codemode target family list", () => {
    const types = createCodemodeTypes({ families: piCodemodeRuntimeToolFamilies });
    const domainProviderTypes = types.slice(
      types.indexOf("// ── Backoffice domain tool providers"),
    );

    expect(domainProviderTypes).toMatchInlineSnapshot(`
      "// ── Backoffice domain tool providers ───────────────────────────────────

      // automations tools
      type AutomationsLookupBindingInput = {
        source: string;
        key: string;
      };
      type AutomationsLookupBindingOutput = {
        id?: string;
        source: string;
        key: string;
        value: string;
        description?: string | null;
        status: string;
        /** ISO 8601 datetime string. */
        linkedAt?: string;
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      } | null;
      type AutomationsBindActorInput = {
        source: string;
        key: string;
        value: string;
        description?: string;
      };
      type AutomationsBindActorOutput = {
        id?: string;
        source: string;
        key: string;
        value: string;
        description?: string | null;
        status: string;
        /** ISO 8601 datetime string. */
        linkedAt?: string;
        /** ISO 8601 datetime string. */
        createdAt?: string;
        /** ISO 8601 datetime string. */
        updatedAt?: string;
      };

      declare const automations: {
        /** Lookup a linked automation identity binding by source and key. */
        lookupBinding(input: AutomationsLookupBindingInput): Promise<AutomationsLookupBindingOutput>;
        /** Create or update an automation identity binding. */
        bindActor(input: AutomationsBindActorInput): Promise<AutomationsBindActorOutput>;
      };

      // otp tools
      type OtpCreateIdentityClaimInput = {
        source: string;
        externalActorId: string;
        ttlMinutes?: number;
      };
      type OtpCreateIdentityClaimOutput = {
        url: string;
        externalId: string;
        code: string;
        type?: string;
        expiresAt?: string;
      };

      declare const otp: {
        /** Create a short-lived identity claim URL for an external actor. */
        createIdentityClaim(input: OtpCreateIdentityClaimInput): Promise<OtpCreateIdentityClaimOutput>;
      };

      // pi tools
      type PiCreateSessionInput = {
        agent: string;
        name?: string;
        systemMessage?: string;
        metadata?: unknown;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiCreateSessionOutput = {
        id: string;
        name: string | null;
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        agent: string;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        metadata?: unknown;
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
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        agentName: string;
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
            events: unknown[];
          };
        metadata?: unknown;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
      };
      type PiListSessionsInput = {
        limit?: number;
      };
      type PiListSessionsOutput = ({
        id: string;
        name: string | null;
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        agent: string;
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        metadata?: unknown;
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
        status: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        workflowName: string;
        /** ISO 8601 datetime string. */
        createdAt: string;
        /** ISO 8601 datetime string. */
        updatedAt: string;
        agentName: string;
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
            events: unknown[];
          };
        metadata?: unknown;
        tags?: string[];
        steeringMode?: "all" | "one-at-a-time";
        assistantText: string;
        commandStatus?: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        messageStatus: "active" | "paused" | "errored" | "terminated" | "complete" | "waiting";
        stream: unknown[];
        terminalState: {
            messages: unknown[];
            errorMessage?: string;
          };
      };

      declare const pi: {
        /** Create a new Pi session. */
        createSession(input: PiCreateSessionInput): Promise<PiCreateSessionOutput>;
        /** Retrieve a Pi session by id. */
        getSession(input: PiGetSessionInput): Promise<PiGetSessionOutput>;
        /** List Pi sessions ordered by creation time. */
        listSessions(input: PiListSessionsInput): Promise<PiListSessionsOutput>;
        /** Send one prompt command through a Pi active session and return the settled result. */
        runTurn(input: PiRunTurnInput): Promise<PiRunTurnOutput>;
      };

      // resend tools
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

      declare const resend: {
        /** Load a Resend thread with a page of messages and a Markdown snapshot. */
        getThread(input: ResendGetThreadInput): Promise<ResendGetThreadOutput>;
        /** List Resend email threads. */
        listThreads(input: ResendListThreadsInput): Promise<ResendListThreadsOutput>;
        /** Send a text reply into an existing Resend thread. */
        replyToThread(input: ResendReplyToThreadInput): Promise<ResendReplyToThreadOutput>;
      };

      // reson8 tools
      type Reson8TranscribePrerecordedInput = {
        inputPath?: string;
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

      declare const reson8: {
        /** Transcribe a prerecorded audio file via Reson8. */
        transcribePrerecorded(input: Reson8TranscribePrerecordedInput): Promise<Reson8TranscribePrerecordedOutput>;
      };

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
});
