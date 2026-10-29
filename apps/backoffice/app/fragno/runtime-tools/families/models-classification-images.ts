import {
  MODELS_CLASSIFY_IMAGE_LIMITS,
  type ModelsFile,
} from "@fragno-dev/backoffice-api/v0/models";

import type { ImageContent } from "@earendil-works/pi-ai";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { bytesToBase64 } from "@/lib/base64";
import { rasterImageContentType } from "@/lib/raster-image-content-type";

import { modelsFileLabel, readModelsFileBytes, type ModelsFileStores } from "./models-file-bytes";

/** Reads already-authorized images within a shared byte budget, preserving caller order. */
export async function readClassificationImages(
  stores: ModelsFileStores,
  files: readonly ModelsFile[],
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  let remainingBytes = MODELS_CLASSIFY_IMAGE_LIMITS.totalBytes;
  for (const file of files) {
    // Sequential reads bound memory and apply the remaining budget even if a file changes size.
    const maxBytes = Math.min(MODELS_CLASSIFY_IMAGE_LIMITS.perImageBytes, remainingBytes);
    const read = await readModelsFileBytes(stores, file, maxBytes);
    if (read.kind === "too-large") {
      throw new BackofficeOperationError(
        "invalid_request",
        `MODELS_CLASSIFY_IMAGE_TOO_LARGE: ${modelsFileLabel(file)} exceeds the ${maxBytes} bytes left to read; images hold at most ${MODELS_CLASSIFY_IMAGE_LIMITS.perImageBytes} bytes each and ${MODELS_CLASSIFY_IMAGE_LIMITS.totalBytes} together.`,
      );
    }
    const mimeType = rasterImageContentType(read.bytes);
    if (mimeType === null || mimeType === "image/gif") {
      throw new BackofficeOperationError(
        "invalid_request",
        `MODELS_CLASSIFY_INVALID_IMAGE: ${modelsFileLabel(file)} must contain a PNG, JPEG, or WebP image.`,
      );
    }
    remainingBytes -= read.bytes.byteLength;
    images.push({ type: "image", data: bytesToBase64(read.bytes), mimeType });
  }
  return images;
}
