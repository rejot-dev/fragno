import { MODELS_EXTRACT_FILE_LIMITS } from "@fragno-dev/backoffice-api/v0/models";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import {
  StateFileReadLimitError,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import type { PiExtractionFile } from "@/fragno/pi/agent/openai-extraction";
import { rasterImageContentType } from "@/lib/raster-image-content-type";

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Recognizes the file by its signature, never by its user-controlled name. */
function extractionMimeType(bytes: Uint8Array): PiExtractionFile["mimeType"] | null {
  if (PDF_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return "application/pdf";
  }
  const imageType = rasterImageContentType(bytes);
  return imageType === "image/gif" ? null : imageType;
}

/** Reads already-authorized paths within a shared byte budget, preserving caller order. */
export async function readExtractionFiles(
  state: BackofficeStateBackend,
  paths: readonly string[],
): Promise<PiExtractionFile[]> {
  const files: PiExtractionFile[] = [];
  let remainingBytes = MODELS_EXTRACT_FILE_LIMITS.totalBytes;
  for (const path of paths) {
    // Sequential reads bound memory and apply the remaining budget even if a file changes size.
    let bytes: Uint8Array;
    try {
      bytes = await state.readFileBytes(path, remainingBytes);
    } catch (error) {
      if (error instanceof StateFileReadLimitError) {
        throw new BackofficeOperationError(
          "invalid_request",
          `MODELS_EXTRACT_FILES_TOO_LARGE: ${path} exceeds what is left of the ${MODELS_EXTRACT_FILE_LIMITS.totalBytes} bytes one call reads.`,
        );
      }
      throw error;
    }
    const mimeType = extractionMimeType(bytes);
    if (mimeType === null) {
      throw new BackofficeOperationError(
        "invalid_request",
        `MODELS_EXTRACT_INVALID_FILE: ${path} must contain a PDF or a PNG, JPEG, or WebP image.`,
      );
    }
    remainingBytes -= bytes.byteLength;
    files.push({ filename: path.slice(path.lastIndexOf("/") + 1), mimeType, bytes });
  }
  return files;
}
