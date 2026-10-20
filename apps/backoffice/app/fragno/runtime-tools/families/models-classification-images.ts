import { MODELS_CLASSIFY_IMAGE_LIMITS } from "@fragno-dev/backoffice-api/v0/models";

import type { ImageContent } from "@earendil-works/pi-ai";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  StateFileReadLimitError,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { bytesToBase64 } from "@/lib/base64";
import { rasterImageContentType } from "@/lib/raster-image-content-type";

/** Reads already-authorized paths within a shared byte budget, preserving caller order. */
export async function readClassificationImages(
  state: BackofficeStateBackend,
  paths: readonly string[],
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  let remainingBytes = MODELS_CLASSIFY_IMAGE_LIMITS.totalBytes;
  for (const path of paths) {
    // Sequential reads bound memory and apply the remaining budget even if a file changes size.
    let bytes: Uint8Array;
    try {
      bytes = await state.readFileBytes(
        path,
        Math.min(MODELS_CLASSIFY_IMAGE_LIMITS.perImageBytes, remainingBytes),
      );
    } catch (error) {
      if (error instanceof StateFileReadLimitError) {
        throw new BackofficeOperationError(
          "invalid_request",
          `MODELS_CLASSIFY_IMAGE_TOO_LARGE: ${path}: ${error.message}`,
        );
      }
      throw error;
    }
    const mimeType = rasterImageContentType(bytes);
    if (mimeType === null || mimeType === "image/gif") {
      throw new BackofficeOperationError(
        "invalid_request",
        `MODELS_CLASSIFY_INVALID_IMAGE: ${path} must contain a PNG, JPEG, or WebP image.`,
      );
    }
    remainingBytes -= bytes.byteLength;
    images.push({ type: "image", data: bytesToBase64(bytes), mimeType });
  }
  return images;
}
