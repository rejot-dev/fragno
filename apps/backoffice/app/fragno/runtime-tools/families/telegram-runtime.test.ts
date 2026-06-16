import { describe, expect, it, assert } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "../bash-host";
import { EMPTY_BASH_HOST_CONTEXT } from "../bash-host.test-utils";
import { createRouteBackedTelegramRuntime, type TelegramRuntime } from "./telegram-runtime";

const createTelegramRuntime = (overrides: Partial<TelegramRuntime> = {}): TelegramRuntime => ({
  getFile: async ({ fileId }) => ({
    fileId,
    fileUniqueId: `unique-${fileId}`,
    filePath: `voice/${fileId}.ogg`,
    fileSize: 4,
  }),
  downloadFile: async () => new Response(new Uint8Array([0, 255, 1, 2])),
  sendMessage: async () => ({ ok: true, queued: true }),
  sendChatAction: async () => ({ ok: true }),
  editMessage: async () => ({ ok: true, queued: true }),
  ...overrides,
});

describe("telegram bash command registration", () => {
  it("returns normalized metadata and preserves binary downloads through redirection", async () => {
    const fs = new InMemoryFs();
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const result = await bash.exec(
      "mkdir -p /tmp\n" +
        "telegram.file.get --file-id file-1 --print filePath\n" +
        "telegram.file.download --file-id file-1 > /tmp/file.bin",
    );

    assert(result.exitCode === 0);
    assert(result.stdout.trim() === "voice/file-1.ogg");
    await expect(fs.readFileBuffer("/tmp/file.bin")).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.file.get",
        output: "voice/file-1.ogg",
        exitCode: 0,
      },
      {
        command: "telegram.file.download",
        output: "<binary>",
        exitCode: 0,
      },
    ]);
  });

  it("supports chat send, typing action, and message edit commands", async () => {
    const fs = new InMemoryFs();
    const calls: unknown[] = [];
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime({
            sendMessage: async (args) => {
              calls.push(args);
              return { ok: true, queued: true };
            },
          }),
        },
      },
    });

    const result = await bash.exec(
      'telegram.chat.send -c chat-1 -t "Hello"\n' +
        "telegram.chat.actions --chat-id chat-1 --action typing\n" +
        'telegram.message.edit --chat-id chat-1 --message-id 123 --text "Updated"',
    );

    assert(result.exitCode === 0);
    expect(calls).toEqual([
      expect.objectContaining({
        chatId: "chat-1",
        text: "Hello",
        parseMode: "Markdown",
      }),
    ]);
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.chat.send",
        output: expect.any(String),
        exitCode: 0,
      },
      {
        command: "telegram.chat.actions",
        output: expect.any(String),
        exitCode: 0,
      },
      {
        command: "telegram.message.edit",
        output: expect.any(String),
        exitCode: 0,
      },
    ]);
  });

  it("writes bytes directly to a file when --output is specified", async () => {
    const fs = new InMemoryFs();
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const result = await bash.exec(
      "mkdir -p /workspace\ntelegram.file.download --file-id file-1 --output /workspace/photo.bin",
    );

    assert(result.exitCode === 0);
    expect(result.stdout).toContain("Downloaded 4 bytes to /workspace/photo.bin");
    await expect(fs.readFileBuffer("/workspace/photo.bin")).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.file.download",
        output: "Downloaded 4 bytes to /workspace/photo.bin",
        exitCode: 0,
      },
    ]);
  });

  it("supports -o shorthand for --output", async () => {
    const fs = new InMemoryFs();
    const { bash } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    await bash.exec("mkdir -p /tmp\ntelegram.file.download --file-id file-1 -o /tmp/out.bin");

    await expect(fs.readFileBuffer("/tmp/out.bin")).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
  });

  it("resolves relative --output paths against cwd", async () => {
    const fs = new InMemoryFs();
    const { bash } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    await bash.exec(
      "mkdir -p /workspace\ncd /workspace\ntelegram.file.download --file-id file-1 -o attachment.bin",
    );

    await expect(fs.readFileBuffer("/workspace/attachment.bin")).resolves.toEqual(
      new Uint8Array([0, 255, 1, 2]),
    );
  });

  it("fails downloads cleanly when Telegram returns a non-success response", async () => {
    const fs = new InMemoryFs();
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime({
            downloadFile: async () =>
              new Response(JSON.stringify({ message: "Telegram file not found" }), {
                status: 404,
                headers: {
                  "content-type": "application/json",
                },
              }),
          }),
        },
      },
    });

    const result = await bash.exec(
      "mkdir -p /workspace\ntelegram.file.download --file-id missing -o /workspace/photo.bin",
    );

    assert(result.exitCode === 1);
    assert(result.stdout === "");
    expect(result.stderr).toContain("Telegram fragment returned 404: Telegram file not found");
    await expect(fs.readFileBuffer("/workspace/photo.bin")).rejects.toThrow();
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.file.download",
        output: "",
        exitCode: 1,
      },
    ]);
  });

  it("uses the shared not-configured message for telegram.file.download", async () => {
    const fs = new InMemoryFs();
    const { bash } = createBashHost({
      fs,
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime({
            downloadFile: async () => Response.json({ code: "NOT_CONFIGURED" }, { status: 400 }),
          }),
        },
      },
    });

    const result = await bash.exec("telegram.file.download --file-id missing");

    assert(result.exitCode === 1);
    expect(result.stderr).toContain("Telegram is not configured for this organisation.");
  });

  it("uses the shared route error formatting for telegram route-backed commands", async () => {
    const runtime = createRouteBackedTelegramRuntime({
      baseUrl: "https://telegram.do",
      fetch: async () => Response.json({ message: "Chat not found" }, { status: 404 }),
    });

    await expect(runtime.sendMessage({ chatId: "chat-1", text: "hello" })).rejects.toThrow(
      "Telegram fragment returned 404: Chat not found",
    );
  });

  it("shows help for telegram file commands", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        ...EMPTY_BASH_HOST_CONTEXT,
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const getHelp = await bash.exec("telegram.file.get --help");
    const downloadHelp = await bash.exec("telegram.file.download --help");

    assert(getHelp.exitCode === 0);
    expect(getHelp.stdout).toContain("telegram.file.get");
    expect(getHelp.stdout).toContain("--file-id");
    assert(downloadHelp.exitCode === 0);
    expect(downloadHelp.stdout).toContain("telegram.file.download");
    expect(downloadHelp.stdout).toContain("--file-id");
    expect(commandCallsResult).toEqual([
      {
        command: "telegram.file.get",
        output: expect.stringContaining("telegram.file.get"),
        exitCode: 0,
      },
      {
        command: "telegram.file.download",
        output: expect.stringContaining("telegram.file.download"),
        exitCode: 0,
      },
    ]);
  });
});
