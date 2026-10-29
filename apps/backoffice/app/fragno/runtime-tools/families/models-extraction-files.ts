import { MODELS_EXTRACT_FILE_LIMITS, type ModelsFile } from "@fragno-dev/backoffice-api/v0/models";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { PiExtractionFile } from "@/fragno/pi/agent/openai-extraction";
import { rasterImageContentType } from "@/lib/raster-image-content-type";

import {
  modelsFileLabel,
  modelsFileName,
  readModelsFileBytes,
  type ModelsFileStores,
} from "./models-file-bytes";

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Recognizes the file by its signature, never by its user-controlled name. */
function extractionMimeType(bytes: Uint8Array): PiExtractionFile["mimeType"] | null {
  if (PDF_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return "application/pdf";
  }
  const imageType = rasterImageContentType(bytes);
  return imageType === "image/gif" ? null : imageType;
}

/** Reads already-authorized files within a shared byte budget, preserving caller order. */
export async function readExtractionFiles(
  stores: ModelsFileStores,
  files: readonly ModelsFile[],
): Promise<PiExtractionFile[]> {
  const extractionFiles: PiExtractionFile[] = [];
  let remainingBytes = MODELS_EXTRACT_FILE_LIMITS.totalBytes;
  for (const file of files) {
    // Sequential reads bound memory and apply the remaining budget even if a file changes size.
    const read = await readModelsFileBytes(stores, file, remainingBytes);
    if (read.kind === "too-large") {
      throw new BackofficeOperationError(
        "invalid_request",
        `MODELS_EXTRACT_FILES_TOO_LARGE: ${modelsFileLabel(file)} exceeds what is left of the ${MODELS_EXTRACT_FILE_LIMITS.totalBytes} bytes one call reads.`,
      );
    }
    const mimeType = extractionMimeType(read.bytes);
    if (mimeType === null) {
      throw new BackofficeOperationError(
        "invalid_request",
        `MODELS_EXTRACT_INVALID_FILE: ${modelsFileLabel(file)} must contain a PDF or a PNG, JPEG, or WebP image.`,
      );
    }
    remainingBytes -= read.bytes.byteLength;
    extractionFiles.push({ filename: modelsFileName(file), mimeType, bytes: read.bytes });
  }
  return extractionFiles;
}
