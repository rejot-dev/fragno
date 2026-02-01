import { decodeFileKey, encodeFileKey, type FileKeyEncoded, type FileKeyParts } from "../keys";

export type FileKeyInput = {
  keyParts?: FileKeyParts;
  fileKey?: FileKeyEncoded;
};

export const resolveFileKeyInput = (
  input: FileKeyInput,
): {
  fileKey: FileKeyEncoded;
  fileKeyParts: FileKeyParts;
} => {
  const { keyParts, fileKey } = input;

  if ((!keyParts || keyParts.length === 0) && (!fileKey || fileKey.length === 0)) {
    throw new Error("INVALID_FILE_KEY");
  }

  if (keyParts && fileKey) {
    let decoded: FileKeyParts;
    try {
      decoded = decodeFileKey(fileKey);
    } catch {
      throw new Error("INVALID_FILE_KEY");
    }

    const encoded = encodeFileKey(keyParts);
    if (encoded !== fileKey) {
      throw new Error("INVALID_FILE_KEY");
    }

    return { fileKey, fileKeyParts: decoded };
  }

  if (keyParts) {
    return { fileKey: encodeFileKey(keyParts), fileKeyParts: keyParts };
  }

  try {
    return { fileKey: fileKey!, fileKeyParts: decodeFileKey(fileKey!) };
  } catch {
    throw new Error("INVALID_FILE_KEY");
  }
};
