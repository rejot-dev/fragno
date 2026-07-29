import { UploadServiceError } from "../services/errors";
import { UploadStorageError } from "../storage/errors";
import type { StorageAdapter, UploadChecksum } from "../storage/types";
import type { UploadStrategy } from "../types";

type InitializedUpload = Awaited<ReturnType<StorageAdapter["initUpload"]>>;

type MultipartUploadSnapshot = {
  objectKey: string;
  storageUploadId: string | null;
  partSizeBytes: number | null;
};

type DirectUploadSnapshot = MultipartUploadSnapshot & {
  strategy: UploadStrategy;
  expectedSizeBytes: bigint;
  checksum: UploadChecksum | null;
};

type ProxyUploadSnapshot = {
  objectKey: string;
  contentType: string;
  expectedSizeBytes: bigint;
};

export function mapStorageOperationError(cause: unknown): UploadServiceError {
  if (cause instanceof UploadServiceError) {
    return cause;
  }

  if (cause instanceof UploadStorageError && cause.code === "INVALID_CHECKSUM") {
    return new UploadServiceError(
      "INVALID_CHECKSUM",
      "The upload checksum is invalid.",
      undefined,
      {
        cause,
      },
    );
  }

  return new UploadServiceError("STORAGE_ERROR", "The storage operation failed.", undefined, {
    cause,
  });
}

function requireMultipartStorageUploadId(upload: MultipartUploadSnapshot): string {
  if (!upload.storageUploadId) {
    throw new UploadServiceError(
      "UPLOAD_INVALID_STATE",
      "The upload has no active multipart storage session.",
    );
  }

  return upload.storageUploadId;
}

export async function discardUnusedMultipartUpload(
  storage: StorageAdapter,
  initializedUpload: InitializedUpload,
): Promise<void> {
  if (
    initializedUpload.strategy !== "direct-multipart" ||
    !initializedUpload.storageUploadId ||
    !storage.abortMultipartUpload
  ) {
    return;
  }

  try {
    await storage.abortMultipartUpload({
      storageKey: initializedUpload.storageKey,
      storageUploadId: initializedUpload.storageUploadId,
    });
  } catch {
    // No upload record was committed, so this best-effort cleanup has no durable retry identity.
  }
}

export async function issueMultipartPartUploadUrls(
  storage: StorageAdapter,
  upload: MultipartUploadSnapshot,
  partNumbers: number[],
) {
  if (!storage.getPartUploadUrls) {
    throw new UploadServiceError("STORAGE_ERROR", "Multipart uploads are not supported.");
  }
  if (upload.partSizeBytes === null) {
    throw new UploadServiceError("UPLOAD_INVALID_STATE", "The upload has no multipart part size.");
  }

  const storageUploadId = requireMultipartStorageUploadId(upload);

  try {
    return await storage.getPartUploadUrls({
      storageKey: upload.objectKey,
      storageUploadId,
      partNumbers,
      partSizeBytes: upload.partSizeBytes,
    });
  } catch (cause) {
    throw mapStorageOperationError(cause);
  }
}

export async function finalizeDirectUploadObject(
  storage: StorageAdapter,
  upload: DirectUploadSnapshot,
  parts: { partNumber: number; etag: string }[] | undefined,
): Promise<bigint | undefined> {
  if (upload.strategy === "direct-multipart") {
    if (!storage.completeMultipartUpload) {
      throw new UploadServiceError("STORAGE_ERROR", "Multipart completion is not supported.");
    }
    if (!parts || parts.length === 0) {
      throw new UploadServiceError(
        "UPLOAD_INVALID_STATE",
        "Multipart completion requires uploaded parts.",
      );
    }

    const storageUploadId = requireMultipartStorageUploadId(upload);

    try {
      await storage.completeMultipartUpload({
        storageKey: upload.objectKey,
        storageUploadId,
        parts,
      });
      return undefined;
    } catch (cause) {
      throw mapStorageOperationError(cause);
    }
  }

  if (!storage.finalizeUpload) {
    return undefined;
  }

  try {
    const result = await storage.finalizeUpload({
      storageKey: upload.objectKey,
      expectedSizeBytes: upload.expectedSizeBytes,
      checksum: upload.checksum,
    });
    return result.sizeBytes;
  } catch (cause) {
    throw mapStorageOperationError(cause);
  }
}

export async function abortMultipartUploadObject(
  storage: StorageAdapter,
  upload: MultipartUploadSnapshot,
): Promise<void> {
  if (!storage.abortMultipartUpload) {
    return;
  }

  const storageUploadId = requireMultipartStorageUploadId(upload);

  try {
    await storage.abortMultipartUpload({
      storageKey: upload.objectKey,
      storageUploadId,
    });
  } catch (cause) {
    throw mapStorageOperationError(cause);
  }
}

export async function storeProxyUploadObject(
  storage: StorageAdapter,
  upload: ProxyUploadSnapshot,
  body: ReadableStream<Uint8Array>,
): Promise<{ etag?: string; sizeBytes?: bigint }> {
  if (!storage.writeStream) {
    throw new UploadServiceError("STORAGE_ERROR", "Proxy uploads are not supported.");
  }

  try {
    return await storage.writeStream({
      storageKey: upload.objectKey,
      body,
      contentType: upload.contentType,
      sizeBytes: upload.expectedSizeBytes,
    });
  } catch (cause) {
    throw mapStorageOperationError(cause);
  }
}
