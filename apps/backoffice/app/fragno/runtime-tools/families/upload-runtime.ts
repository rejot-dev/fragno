import { z } from "zod";

import type { UploadObject } from "@/backoffice-runtime/object-registry";
import type {
  PreparedUploadedFileReference,
  UploadedFileReference,
} from "@/fragno/prepared-upload";

export type UploadReadPreparedInput = {
  file: PreparedUploadedFileReference;
  encoding?: "utf8" | "base64" | "bytes";
  maxBytes?: number;
};

export type UploadReadPreparedOutput =
  | {
      file: PreparedUploadedFileReference;
      encoding: "utf8";
      text: string;
      byteLength: number;
    }
  | {
      file: PreparedUploadedFileReference;
      encoding: "base64";
      base64: string;
      byteLength: number;
    }
  | {
      file: PreparedUploadedFileReference;
      encoding: "bytes";
      bytes: Uint8Array;
      byteLength: number;
    };

export type UploadRuntime = {
  readPrepared(input: UploadReadPreparedInput): Promise<UploadReadPreparedOutput>;
  commitPrepared(input: { file: PreparedUploadedFileReference }): Promise<UploadedFileReference>;
  discardPrepared(input: {
    file: PreparedUploadedFileReference;
  }): Promise<{ discarded: true; uploadId: string }>;
};

const DEFAULT_MAX_READ_BYTES = 10 * 1_024 * 1_024;
const MAX_READ_BYTES = 50 * 1_024 * 1_024;

const committedUploadResponseSchema = z.object({
  files: z.tuple([
    z.object({
      fileKey: z.string(),
      provider: z.string(),
    }),
  ]),
});

const uploadErrorPayloadSchema = z.object({
  message: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

type UploadFetch = (request: Request) => Promise<Response>;

const uploadErrorMessage = async (response: Response): Promise<string> => {
  const payload = uploadErrorPayloadSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => null),
  );
  return payload.success
    ? (payload.data.message ??
        payload.data.error?.message ??
        `Upload request failed (${response.status}).`)
    : `Upload request failed (${response.status}).`;
};

const callUpload = async (
  fetchUpload: UploadFetch,
  path: string,
  init?: RequestInit,
): Promise<Response> => {
  const response = await fetchUpload(
    new Request(`https://upload.internal/api/upload${path}`, init),
  );
  if (!response.ok) {
    throw new Error(await uploadErrorMessage(response));
  }
  return response;
};

const readPreparedUpload = async (
  fetchUpload: UploadFetch,
  file: PreparedUploadedFileReference,
): Promise<Response> =>
  await callUpload(fetchUpload, `/uploads/${encodeURIComponent(file.uploadId)}/content`);

const preparedUploadReadLimitError = (sizeBytes: number, maxBytes: number) =>
  new Error(`Prepared upload is ${sizeBytes} bytes, exceeding the ${maxBytes} byte read limit.`);

const readResponseBytes = async (response: Response, maxBytes: number): Promise<Uint8Array> => {
  if (!response.body) {
    return new Uint8Array();
  }

  const body = response.body as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  let bytes = new Uint8Array();
  let byteLength = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return bytes.subarray(0, byteLength);
      }

      const nextByteLength = byteLength + chunk.value.byteLength;
      if (nextByteLength > maxBytes) {
        const error = preparedUploadReadLimitError(nextByteLength, maxBytes);
        await reader.cancel(error);
        throw error;
      }

      if (nextByteLength > bytes.byteLength) {
        const nextCapacity = Math.min(
          maxBytes,
          Math.max(nextByteLength, bytes.byteLength === 0 ? 64 * 1_024 : bytes.byteLength * 2),
        );
        const expandedBytes = new Uint8Array(nextCapacity);
        expandedBytes.set(bytes.subarray(0, byteLength));
        bytes = expandedBytes;
      }

      bytes.set(chunk.value, byteLength);
      byteLength = nextByteLength;
    }
  } finally {
    reader.releaseLock();
  }
};

const commitPreparedUpload = async (
  fetchUpload: UploadFetch,
  file: PreparedUploadedFileReference,
): Promise<UploadedFileReference> => {
  const response = await callUpload(fetchUpload, "/files/commit-prepared", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      entries: [
        {
          kind: "write",
          uploadId: file.uploadId,
          precondition: { kind: "absent" },
        },
      ],
    }),
  });
  const { files } = committedUploadResponseSchema.parse(await response.json());
  const [committedFile] = files;
  if (committedFile.fileKey !== file.fileKey || committedFile.provider !== file.provider) {
    throw new Error("Committed upload did not match the prepared file reference.");
  }
  return {
    kind: "uploaded-file",
    scope: file.scope,
    uploadId: file.uploadId,
    provider: file.provider,
    fileKey: file.fileKey,
    filename: file.filename,
    sizeBytes: file.sizeBytes,
    contentType: file.contentType,
  };
};

const discardPreparedUpload = async (
  fetchUpload: UploadFetch,
  file: PreparedUploadedFileReference,
): Promise<void> => {
  await callUpload(fetchUpload, `/uploads/${encodeURIComponent(file.uploadId)}/abort`, {
    method: "POST",
  });
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 32_768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

export const createUploadRuntime = (object: UploadObject): UploadRuntime => {
  const fetchUpload = (request: Request) => object.fetch(request);

  return {
    readPrepared: async ({ file, encoding = "utf8", maxBytes = DEFAULT_MAX_READ_BYTES }) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_READ_BYTES) {
        throw new Error(`upload.readPrepared maxBytes must be between 1 and ${MAX_READ_BYTES}.`);
      }
      if (file.sizeBytes > maxBytes) {
        throw preparedUploadReadLimitError(file.sizeBytes, maxBytes);
      }

      const response = await readPreparedUpload(fetchUpload, file);
      const contentLength = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw preparedUploadReadLimitError(contentLength, maxBytes);
      }

      const bytes = await readResponseBytes(response, maxBytes);

      if (encoding === "bytes") {
        return { file, encoding, bytes, byteLength: bytes.byteLength };
      }

      if (encoding === "base64") {
        return {
          file,
          encoding,
          base64: bytesToBase64(bytes),
          byteLength: bytes.byteLength,
        };
      }

      try {
        return {
          file,
          encoding,
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          byteLength: bytes.byteLength,
        };
      } catch {
        throw new Error(
          'Prepared upload is not valid UTF-8. Read it again with encoding: "bytes" or "base64".',
        );
      }
    },
    commitPrepared: async ({ file }) => await commitPreparedUpload(fetchUpload, file),
    discardPrepared: async ({ file }) => {
      await discardPreparedUpload(fetchUpload, file);
      return { discarded: true, uploadId: file.uploadId };
    },
  };
};
