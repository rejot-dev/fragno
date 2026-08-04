import { describe, expect, test, vi } from "vitest";

import type { PreparedUploadedFileReference } from "@/fragno/prepared-upload";

import {
  createTrustedSystemBackofficeToolContext,
  type BackofficeToolContext,
} from "../runtime-tools";
import { uploadRuntimeTools } from "./upload";
import type { UploadRuntime } from "./upload-runtime";

const file: PreparedUploadedFileReference = {
  kind: "prepared-upload",
  scope: { kind: "org", orgId: "org-1" },
  uploadId: "upload-1",
  provider: "database",
  fileKey: "generated-ui/file.txt",
  filename: "file.txt",
  sizeBytes: 5,
  contentType: "text/plain",
  expiresAt: "2027-01-01T00:00:00.000Z",
};

const createContext = (
  runtime: UploadRuntime,
  orgId = "org-1",
): BackofficeToolContext<{ upload: UploadRuntime }> =>
  createTrustedSystemBackofficeToolContext({ runtimes: { upload: runtime } }).createScopedContext({
    kind: "org",
    orgId,
  });

const createRuntime = (): UploadRuntime => {
  const readPrepared: UploadRuntime["readPrepared"] = vi.fn(
    async ({ file: inputFile, encoding = "utf8" }) => {
      if (encoding === "bytes") {
        return {
          file: inputFile,
          encoding,
          bytes: new TextEncoder().encode("hello"),
          byteLength: 5,
        };
      }
      if (encoding === "base64") {
        return {
          file: inputFile,
          encoding,
          base64: "aGVsbG8=",
          byteLength: 5,
        };
      }
      return {
        file: inputFile,
        encoding,
        text: "hello",
        byteLength: 5,
      };
    },
  );
  const commitPrepared: UploadRuntime["commitPrepared"] = vi.fn(async ({ file: inputFile }) => ({
    kind: "uploaded-file" as const,
    scope: inputFile.scope,
    uploadId: inputFile.uploadId,
    provider: inputFile.provider,
    fileKey: inputFile.fileKey,
    filename: inputFile.filename,
    sizeBytes: inputFile.sizeBytes,
    contentType: inputFile.contentType,
  }));
  const discardPrepared: UploadRuntime["discardPrepared"] = vi.fn(async ({ file: inputFile }) => ({
    discarded: true as const,
    uploadId: inputFile.uploadId,
  }));
  return { readPrepared, commitPrepared, discardPrepared };
};

describe("Upload runtime tools", () => {
  test("exposes the prepared upload lifecycle in codemode", () => {
    expect(uploadRuntimeTools.map((tool) => tool.name)).toEqual([
      "readPrepared",
      "commitPrepared",
      "discardPrepared",
    ]);
  });

  test("reads a prepared upload through the semantic runtime", async () => {
    const runtime = createRuntime();

    await expect(
      uploadRuntimeTools[0].execute({ file, encoding: "utf8" }, createContext(runtime)),
    ).resolves.toMatchObject({ text: "hello", byteLength: 5 });
    expect(runtime.readPrepared).toHaveBeenCalledWith({ file, encoding: "utf8" });
  });

  test("returns prepared upload bytes through the validated tool contract", async () => {
    const runtime = createRuntime();
    const result = await uploadRuntimeTools[0].execute(
      { file, encoding: "bytes" },
      createContext(runtime),
    );

    expect(uploadRuntimeTools[0].outputSchema.parse(result)).toEqual({
      file,
      encoding: "bytes",
      bytes: new TextEncoder().encode("hello"),
      byteLength: 5,
    });
    expect(runtime.readPrepared).toHaveBeenCalledWith({ file, encoding: "bytes" });
  });

  test("formats prepared upload bytes as binary command output", () => {
    const format = uploadRuntimeTools[0].adapters?.bash?.format;
    expect(format).toBeTypeOf("function");

    expect(
      format!(
        {
          file,
          encoding: "bytes",
          bytes: new Uint8Array([0, 1, 2, 255]),
          byteLength: 4,
        },
        { format: "text" },
      ),
    ).toEqual({
      stdout: "\u0000\u0001\u0002ÿ",
      stdoutEncoding: "binary",
    });
  });

  test("rejects a reference from a different scoped provider", async () => {
    const runtime = createRuntime();

    await expect(
      uploadRuntimeTools[2].execute({ file }, createContext(runtime, "org-2")),
    ).rejects.toThrow("Prepared upload scope must match");
    expect(runtime.discardPrepared).not.toHaveBeenCalled();
  });
});
