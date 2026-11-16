import { afterEach, assert, describe, expect, test } from "vitest";

import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeBackofficeSystemPrompt } from "./system-prompt-output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "backoffice-system-prompt-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Backoffice system prompt output", () => {
  test("writes to stdout when no output file is requested", async () => {
    let stdout = "";

    await expect(
      writeBackofficeSystemPrompt({
        systemPrompt: "# Backoffice\n",
        outputFile: null,
        writeStdout(content) {
          stdout += content;
        },
      }),
    ).resolves.toEqual({ kind: "stdout" });
    assert.equal(stdout, "# Backoffice\n");
  });

  test("creates an explicit output file with owner-only permissions", async () => {
    const directory = await createTemporaryDirectory();
    const outputFile = join(directory, "SYSTEM.md");

    await expect(
      writeBackofficeSystemPrompt({
        systemPrompt: "# Backoffice\n",
        outputFile,
        writeStdout() {},
      }),
    ).resolves.toEqual({ kind: "file", outputFile });
    assert.equal(await readFile(outputFile, "utf8"), "# Backoffice\n");
    assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
  });

  test("refuses to overwrite an existing file or follow a symbolic link", async () => {
    const directory = await createTemporaryDirectory();
    const existingFile = join(directory, "existing.md");
    const outputFile = join(directory, "SYSTEM.md");
    await writeFile(existingFile, "keep me");
    await symlink(existingFile, outputFile);

    await expect(
      writeBackofficeSystemPrompt({
        systemPrompt: "replace me",
        outputFile,
        writeStdout() {},
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    assert.equal(await readFile(existingFile, "utf8"), "keep me");
  });
});
