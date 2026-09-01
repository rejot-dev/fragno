import { describe, expect, test, assert } from "vitest";

import { createCodemodeTypeFiles } from "@/fragno/codemode/codemode-dts";

import { createRuntimeToolFamilyReference, toRuntimeToolReference } from "./reference";
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
            "billing-organization-id",
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

  test("renders the state provider at its canonical declaration path", () => {
    const files = createCodemodeTypeFiles({
      families: runtimeToolFamilies,
    });

    assert(files.some((file) => file.path === "/static/codemode/providers/state.d.ts"));
    assert(!files.some((file) => file.path === "/static/codemode/state.d.ts"));
  });
});
