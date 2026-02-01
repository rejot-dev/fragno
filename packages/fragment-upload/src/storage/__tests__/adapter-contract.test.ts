import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFileKey, type FileKeyParts } from "../../keys";
import type { StorageAdapter } from "../types";
import { createFilesystemStorageAdapter } from "../fs";

type AdapterContractContext = {
  adapter: StorageAdapter;
  fileKeyParts: FileKeyParts;
  fileKey: string;
  contentType: string;
  sizeBytes: bigint;
  cleanup?: () => Promise<void>;
  assertDownloadResponse?: (response: Response) => Promise<void> | void;
};

export function describeStorageAdapterContract(
  name: string,
  setup: () => Promise<AdapterContractContext>,
) {
  describe(`${name} storage adapter contract`, () => {
    let context: AdapterContractContext;

    beforeAll(async () => {
      context = await setup();
    });

    afterAll(async () => {
      if (context?.cleanup) {
        await context.cleanup();
      }
    });

    test("initUpload returns a strategy compatible with capabilities", async () => {
      const { adapter, fileKey, fileKeyParts, sizeBytes, contentType } = context;
      const result = await adapter.initUpload({
        fileKey,
        fileKeyParts,
        sizeBytes,
        contentType,
        metadata: null,
      });

      const resolved = adapter.resolveStorageKey({ fileKey, fileKeyParts });
      expect(result.storageKey).toBe(resolved);
      expect(result.expiresAt).toBeInstanceOf(Date);

      if (result.strategy === "proxy") {
        expect(adapter.capabilities.proxyUpload).toBe(true);
      } else if (result.strategy === "direct-single") {
        expect(adapter.capabilities.directUpload).toBe(true);
      } else if (result.strategy === "direct-multipart") {
        expect(adapter.capabilities.directUpload).toBe(true);
        expect(adapter.capabilities.multipartUpload).toBe(true);
      }
    });

    test("proxy upload writes data and download stream returns it", async () => {
      const { adapter, fileKey, fileKeyParts, contentType } = context;
      if (!adapter.capabilities.proxyUpload || !adapter.writeStream) {
        return;
      }

      const storageKey = adapter.resolveStorageKey({ fileKey, fileKeyParts });
      const payload = new TextEncoder().encode(`contract-${randomUUID()}`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      });

      await adapter.writeStream({ storageKey, body, contentType });

      if (!adapter.getDownloadStream) {
        throw new Error("Expected getDownloadStream for proxy adapters");
      }

      const response = await adapter.getDownloadStream({ storageKey });
      await context.assertDownloadResponse?.(response);
      const buffer = new Uint8Array(await response.arrayBuffer());
      expect(buffer).toEqual(payload);
    });

    test("signed downloads return urls and expirations when enabled", async () => {
      const { adapter, fileKey, fileKeyParts } = context;
      if (!adapter.capabilities.signedDownload) {
        return;
      }

      if (!adapter.getDownloadUrl) {
        throw new Error("Expected getDownloadUrl when signedDownload is enabled");
      }

      const storageKey = adapter.resolveStorageKey({ fileKey, fileKeyParts });
      const result = await adapter.getDownloadUrl({
        storageKey,
        expiresInSeconds: 60,
      });

      expect(result.url).toBeTruthy();
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    test("deleteObject removes stored objects", async () => {
      const { adapter, fileKey, fileKeyParts, contentType } = context;
      if (!adapter.capabilities.proxyUpload || !adapter.writeStream || !adapter.getDownloadStream) {
        return;
      }

      const storageKey = adapter.resolveStorageKey({
        fileKey,
        fileKeyParts,
      });
      const payload = new TextEncoder().encode(`delete-${randomUUID()}`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      });

      await adapter.writeStream({ storageKey, body, contentType });
      await adapter.deleteObject({ storageKey });

      await expect(adapter.getDownloadStream({ storageKey })).rejects.toThrow();
    });
  });
}

describeStorageAdapterContract("Filesystem", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-"));
  const adapter = createFilesystemStorageAdapter({
    rootDir,
    storageKeyPrefix: "uploads",
    uploadExpiresInSeconds: 120,
  });
  const fileKeyParts: FileKeyParts = ["users", randomUUID(), "avatar"];

  return {
    adapter,
    fileKeyParts,
    fileKey: encodeFileKey(fileKeyParts),
    contentType: "text/plain",
    sizeBytes: 5n,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
    assertDownloadResponse: (response) => {
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("Content-Length")).toBeTruthy();
    },
  };
});

describe("filesystem adapter storage keys", () => {
  test("uses key parts as path segments and applies prefix", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "fragno-upload-keys-"));
    try {
      const adapter = createFilesystemStorageAdapter({
        rootDir,
        storageKeyPrefix: "files/uploads",
      });

      const fileKeyParts: FileKeyParts = ["users", 12, "avatar"];
      const fileKey = encodeFileKey(fileKeyParts);
      const storageKey = adapter.resolveStorageKey({ fileKey, fileKeyParts });

      expect(storageKey.startsWith("files/uploads/")).toBe(true);
      expect(storageKey.split("/").length).toBe(5);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
