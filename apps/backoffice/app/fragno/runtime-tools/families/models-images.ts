import {
  MODELS_CLASSIFY_IMAGE_LIMITS,
  type ModelsFile,
} from "@fragno-dev/backoffice-api/v0/models";

import type { ImageContent } from "@earendil-works/pi-ai";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { bytesToBase64 } from "@/lib/base64";
import { rasterImageContentType } from "@/lib/raster-image-content-type";

import { modelsFileLabel, readModelsFileBytes, type ModelsFileStores } from "./models-file-bytes";

/** Each operation that sends images to a model, with its budget and error codes. */
const IMAGE_READS = {
  classify: {
    limits: MODELS_CLASSIFY_IMAGE_LIMITS,
    tooLarge: "MODELS_CLASSIFY_IMAGE_TOO_LARGE",
    invalid: "MODELS_CLASSIFY_INVALID_IMAGE",
  },
} as const;

/** Reads already-authorized images within the operation's byte budget, preserving caller order. */
export async function readModelsImages(
  stores: ModelsFileStores,
  files: readonly ModelsFile[],
  operation: keyof typeof IMAGE_READS,
): Promise<ImageContent[]> {
  const { limits, tooLarge, invalid } = IMAGE_READS[operation];
  const images: ImageContent[] = [];
  let remainingBytes: number = limits.totalBytes;
  for (const file of files) {
    // Sequential reads bound memory and apply the remaining budget even if a file changes size.
    const maxBytes = Math.min(limits.perImageBytes, remainingBytes);
    const read = await readModelsFileBytes(stores, file, maxBytes);
    if (read.kind === "too-large") {
      throw new BackofficeOperationError(
        "invalid_request",
        `${tooLarge}: ${modelsFileLabel(file)} exceeds the ${maxBytes} bytes left to read; images hold at most ${limits.perImageBytes} bytes each and ${limits.totalBytes} together.`,
      );
    }
    const mimeType = rasterImageContentType(read.bytes);
    if (mimeType === null || mimeType === "image/gif") {
      throw new BackofficeOperationError(
        "invalid_request",
        `${invalid}: ${modelsFileLabel(file)} must contain a PNG, JPEG, or WebP image.`,
      );
    }
    remainingBytes -= read.bytes.byteLength;
    images.push({ type: "image", data: bytesToBase64(read.bytes), mimeType });
  }
  return images;
}
