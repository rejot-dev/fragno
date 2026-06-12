import { describe, expect, test, assert } from "vitest";

import { telegramRuntimeTools } from "./telegram";

describe("telegram runtime tools", () => {
  test("parse and validate chat send input with shorthand flags", () => {
    const sendMessage = telegramRuntimeTools.find((tool) => tool.id === "telegram.chat.send")!;

    assert(sendMessage.name === "sendMessage");
    expect(
      sendMessage.inputSchema.parse(
        sendMessage.adapters!.bash!.parse([
          "-c",
          "chat-123",
          "-t",
          "Hello",
          "--parse-mode",
          "HTML",
          "--disable-web-page-preview",
          "--reply-to-message-id",
          "42",
        ]),
      ),
    ).toEqual({
      chatId: "chat-123",
      text: "Hello",
      parseMode: "HTML",
      disableWebPagePreview: true,
      replyToMessageId: 42,
    });
  });

  test("parse and validate file download input with output shorthand", () => {
    const downloadFile = telegramRuntimeTools.find((tool) => tool.id === "telegram.file.download")!;

    assert(downloadFile.name === "downloadFile");
    expect(
      downloadFile.inputSchema.parse(
        downloadFile.adapters!.bash!.parse(["--file-id", "file-1", "-o", "/tmp/file.bin"]),
      ),
    ).toEqual({
      fileId: "file-1",
    });
  });

  test("rejects unsupported chat actions", () => {
    const sendChatAction = telegramRuntimeTools.find(
      (tool) => tool.id === "telegram.chat.actions",
    )!;

    expect(() =>
      sendChatAction.adapters!.bash!.parse(["--chat-id", "chat-123", "--action", "upload_photo"]),
    ).toThrow("Unsupported Telegram chat action");
  });
});
