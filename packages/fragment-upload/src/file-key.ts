export type FileKey = string;

export type FileKeyValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: "EMPTY" | "TOO_LONG" | "EMPTY_SEGMENT" | "DOT_SEGMENT" | "CONTROL_CHARACTERS";
    };

export type ValidateFileKeyOptions = {
  maxBytes?: number;
};

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }

  return false;
};

const utf8ByteLength = (value: string): number => {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(value, "utf8");
  }

  return new TextEncoder().encode(value).byteLength;
};

export const validateFileKey = (
  value: string,
  options: ValidateFileKeyOptions = {},
): FileKeyValidationResult => {
  if (value.length === 0) {
    return { valid: false, reason: "EMPTY" };
  }

  if (hasControlCharacters(value)) {
    return { valid: false, reason: "CONTROL_CHARACTERS" };
  }

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return { valid: false, reason: "EMPTY_SEGMENT" };
    }

    if (segment === "." || segment === "..") {
      return { valid: false, reason: "DOT_SEGMENT" };
    }
  }

  if (typeof options.maxBytes === "number" && utf8ByteLength(value) > options.maxBytes) {
    return { valid: false, reason: "TOO_LONG" };
  }

  return { valid: true };
};

export const assertFileKey = (value: string, options?: ValidateFileKeyOptions): FileKey => {
  const result = validateFileKey(value, options);
  if (!result.valid) {
    throw new Error("INVALID_FILE_KEY");
  }
  return value;
};

export const splitFileKey = (value: string): readonly string[] => assertFileKey(value).split("/");
