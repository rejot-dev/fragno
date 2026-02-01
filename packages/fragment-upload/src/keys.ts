export type FileKeyPart = string | number;
export type FileKeyParts = readonly FileKeyPart[];
export type FileKeyEncoded = string;

const base64UrlPattern = /^[A-Za-z0-9_-]*$/;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  const encoder = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!encoder) {
    throw new Error("Base64 encoding is not available");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return encoder(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): string {
  if (!base64UrlPattern.test(value)) {
    throw new Error("Invalid base64url value");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  if (typeof Buffer !== "undefined") {
    return new TextDecoder().decode(Buffer.from(padded, "base64"));
  }

  const decoder = (globalThis as { atob?: (value: string) => string }).atob;
  if (!decoder) {
    throw new Error("Base64 decoding is not available");
  }

  const binary = decoder(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new TextDecoder().decode(bytes);
}

function encodePart(part: FileKeyPart): string {
  if (typeof part === "string") {
    return `s~${base64UrlEncode(part)}`;
  }

  if (typeof part === "number") {
    if (!Number.isFinite(part)) {
      throw new Error("File key number parts must be finite");
    }

    const serialized = String(part);
    if (serialized.includes(".") || serialized.includes("e") || serialized.includes("E")) {
      throw new Error("File key number parts must be integers");
    }

    return `n~${serialized}`;
  }

  throw new Error("File key parts must be strings or numbers");
}

function decodeNumberPart(raw: string): number {
  if (raw.length === 0) {
    throw new Error("Invalid number part");
  }

  if (raw.includes(".") || raw.includes("e") || raw.includes("E")) {
    throw new Error("Invalid number part");
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error("Invalid number part");
  }

  if (String(value) !== raw) {
    throw new Error("Invalid number part");
  }

  return value;
}

export function encodeFileKey(parts: FileKeyParts): FileKeyEncoded {
  if (parts.length === 0) {
    return "";
  }

  return parts.map((part) => encodePart(part)).join(".");
}

export function decodeFileKey(key: FileKeyEncoded): FileKeyParts {
  if (key.length === 0) {
    return [];
  }

  const segments = key.split(".");

  return segments.map((segment) => {
    const prefix = segment.slice(0, 2);
    const payload = segment.slice(2);

    if (prefix === "s~") {
      return base64UrlDecode(payload);
    }

    if (prefix === "n~") {
      return decodeNumberPart(payload);
    }

    throw new Error("Invalid file key segment");
  });
}

export function encodeFileKeyPrefix(parts: FileKeyParts): string {
  if (parts.length === 0) {
    return "";
  }

  return `${encodeFileKey(parts)}.`;
}
