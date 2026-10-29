import type { ModelsFile } from "@fragno-dev/backoffice-api/v0/models";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { BLOBS_MAX_RANGE_BYTES } from "@fragno-dev/blobs/routes";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  StateFileReadLimitError,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";

import type { BackofficeToolContext } from "../runtime-tools";
import type { BlobsRuntime } from "./blobs-runtime";

/** Where a model's files are read from; a context may offer either store, both, or neither. */
export type ModelsFileStores = {
  state: BackofficeStateBackend | undefined;
  blobs: BlobsRuntime | undefined;
};

export type ModelsFileBytes = { kind: "read"; bytes: Uint8Array } | { kind: "too-large" };

/** The file as its caller named it, for errors. */
export function modelsFileLabel(file: ModelsFile): string {
  return "path" in file ? file.path : `blob ${file.blob}`;
}

/** The file's name as a model sees it, without the folders it sits in. */
export function modelsFileName(file: ModelsFile): string {
  const name = "path" in file ? file.path : file.blob;
  return name.slice(name.lastIndexOf("/") + 1);
}

export async function assertModelsFilesReadable(
  context: BackofficeToolContext,
  files: readonly ModelsFile[],
) {
  await context.kernel.assertAuthorizedAll({
    execution: context.execution,
    requirements: files.map((file) => ({
      operation: BACKOFFICE_PERMISSION.upload.read,
      resource: "path" in file ? { path: file.path } : { kind: "blob", key: file.blob },
    })),
  });
}

/** Reads an authorized file whole, or reports that it holds more than `maxBytes`. */
export async function readModelsFileBytes(
  stores: ModelsFileStores,
  file: ModelsFile,
  maxBytes: number,
): Promise<ModelsFileBytes> {
  if ("path" in file) {
    if (!stores.state) {
      throw new Error("Reading workspace files requires the workspace filesystem.");
    }
    try {
      return { kind: "read", bytes: await stores.state.readFileBytes(file.path, maxBytes) };
    } catch (error) {
      if (error instanceof StateFileReadLimitError) {
        return { kind: "too-large" };
      }
      throw error;
    }
  }
  if (!stores.blobs) {
    throw new Error("Reading blobs requires blob storage, which this deployment does not have.");
  }
  return await readBlobBytes(stores.blobs, file.blob, maxBytes);
}

async function readBlobBytes(
  blobs: BlobsRuntime,
  key: string,
  maxBytes: number,
): Promise<ModelsFileBytes> {
  const blob = await blobs.get({ key });
  if (blob === null) {
    throw new BackofficeOperationError("not_found", `BLOB_NOT_FOUND: blob ${key} does not exist.`);
  }
  if (blob.sizeBytes > maxBytes) {
    return { kind: "too-large" };
  }
  const bytes = new Uint8Array(blob.sizeBytes);
  for (let offset = 0; offset < blob.sizeBytes; offset += BLOBS_MAX_RANGE_BYTES) {
    const range = await blobs.read({
      key,
      offset,
      length: Math.min(BLOBS_MAX_RANGE_BYTES, blob.sizeBytes - offset),
    });
    // Each range comes from whatever the key holds then, so a replaced blob would mix two files.
    if (range.etag !== blob.etag) {
      throw new BackofficeOperationError(
        "conflict",
        `BLOB_CHANGED: blob ${key} was replaced while it was read.`,
      );
    }
    bytes.set(range.content, offset);
  }
  return { kind: "read", bytes };
}
