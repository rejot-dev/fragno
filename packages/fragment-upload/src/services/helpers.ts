import { assertFileKey, splitFileKey, type FileKey } from "../file-key";
import type { FileKeyParts } from "../keys";

export type FileKeyInput = {
  keyParts?: FileKeyParts;
  fileKey?: FileKey;
};

const normalizeKeyParts = (keyParts: FileKeyParts): readonly string[] => {
  const normalized: string[] = [];

  for (const part of keyParts) {
    if (typeof part === "string") {
      normalized.push(part);
      continue;
    }

    if (typeof part === "number" && Number.isFinite(part) && Number.isInteger(part)) {
      normalized.push(String(part));
      continue;
    }

    throw new Error("INVALID_FILE_KEY");
  }

  return normalized;
};

export const resolveFileKeyInput = (
  input: FileKeyInput,
): {
  fileKey: FileKey;
  fileKeyParts: FileKeyParts;
} => {
  const { keyParts, fileKey } = input;

  if ((!keyParts || keyParts.length === 0) && (!fileKey || fileKey.length === 0)) {
    throw new Error("INVALID_FILE_KEY");
  }

  if (keyParts && fileKey) {
    try {
      assertFileKey(fileKey);
      const fromParts = normalizeKeyParts(keyParts).join("/");
      assertFileKey(fromParts);
      if (fromParts !== fileKey) {
        throw new Error("INVALID_FILE_KEY");
      }
      return { fileKey, fileKeyParts: splitFileKey(fileKey) };
    } catch {
      throw new Error("INVALID_FILE_KEY");
    }
  }

  if (keyParts) {
    try {
      const normalized = normalizeKeyParts(keyParts);
      const normalizedFileKey = normalized.join("/");
      assertFileKey(normalizedFileKey);
      return { fileKey: normalizedFileKey, fileKeyParts: normalized };
    } catch {
      throw new Error("INVALID_FILE_KEY");
    }
  }

  try {
    assertFileKey(fileKey!);
    return { fileKey: fileKey!, fileKeyParts: splitFileKey(fileKey!) };
  } catch {
    throw new Error("INVALID_FILE_KEY");
  }
};
