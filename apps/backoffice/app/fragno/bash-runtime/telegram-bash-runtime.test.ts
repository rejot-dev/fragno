import { describe, expect, it } from "vitest";

import { InMemoryFs } from "just-bash";

import { createBashHost } from "./bash-host";
import type { TelegramBashRuntime } from "./telegram-bash-runtime";

const createTelegramRuntime = (
  overrides: Partial<TelegramBashRuntime> = {},
): TelegramBashRuntime => ({
  getFile: async ({ fileId }) => ({
    fileId,
    fileUniqueId: `unique-${fileId}`,
    filePath: `voice/${fileId}.ogg`,
    fileSize: 4,
  }),
  downloadFile: async () => new Response(new Uint8Array([0, 255, 1, 2])),
  ...overrides,
});

describe("telegram bash command registration", () => {
  it("returns normalized metadata and preserves binary downloads through redirection", async () => {
    const fs = new InMemoryFs();
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        automation: null,
        automations: null,
        otp: null,
        pi: null,
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

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("voice/file-1.ogg");
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

  it("writes bytes directly to a file when --output is specified", async () => {
    const fs = new InMemoryFs();
    const { bash, commandCallsResult } = createBashHost({
      fs,
      context: {
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const result = await bash.exec(
      "mkdir -p /workspace\ntelegram.file.download --file-id file-1 --output /workspace/photo.bin",
    );

    expect(result.exitCode).toBe(0);
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
        automation: null,
        automations: null,
        otp: null,
        pi: null,
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
        automation: null,
        automations: null,
        otp: null,
        pi: null,
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

  it("shows help for telegram file commands", async () => {
    const { bash, commandCallsResult } = createBashHost({
      fs: new InMemoryFs(),
      context: {
        automation: null,
        automations: null,
        otp: null,
        pi: null,
        resend: null,
        telegram: {
          runtime: createTelegramRuntime(),
        },
      },
    });

    const getHelp = await bash.exec("telegram.file.get --help");
    const downloadHelp = await bash.exec("telegram.file.download --help");

    expect(getHelp.exitCode).toBe(0);
    expect(getHelp.stdout).toContain("telegram.file.get");
    expect(getHelp.stdout).toContain("--file-id");
    expect(downloadHelp.exitCode).toBe(0);
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
