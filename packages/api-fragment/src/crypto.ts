const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type HmacAlgorithm = "sha1" | "sha256" | "sha512";

const hmacHashName = (algorithm: HmacAlgorithm) =>
  ({
    sha1: "SHA-1",
    sha256: "SHA-256",
    sha512: "SHA-512",
  })[algorithm];

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function utf8Bytes(value: string) {
  return textEncoder.encode(value);
}

export function assertAscii(value: string, label: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      throw new Error(`${label} must contain ASCII characters only`);
    }
  }
}

export function asciiToBase64(value: string, label: string) {
  assertAscii(value, label);
  return btoa(value);
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeHex(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

export function decodeBase64(value: string, encoding: "base64" | "base64url") {
  const normalized = normalizeBase64(value, encoding);
  if (!normalized) {
    return null;
  }

  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function decodeBase64ToText(value: string, encoding: "base64" | "base64url") {
  const bytes = decodeBase64(value, encoding);
  if (!bytes) {
    return null;
  }

  return textDecoder.decode(bytes);
}

export function normalizeBase64(value: string, encoding: "base64" | "base64url") {
  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (encoding === "base64url") {
    normalized = normalized.replace(/-/g, "+").replace(/_/g, "/");
  }

  const paddingLength = (4 - (normalized.length % 4)) % 4;
  return `${normalized}${"=".repeat(paddingLength)}`;
}

export function randomBase64Url(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return bytesToBase64Url(data);
}

export async function sha256Bytes(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
}

export async function sha256Base64Url(value: string) {
  return bytesToBase64Url(await sha256Bytes(utf8Bytes(value)));
}

export async function importHmacKey(input: { algorithm: HmacAlgorithm; secret: string }) {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(utf8Bytes(input.secret)),
    { name: "HMAC", hash: hmacHashName(input.algorithm) },
    false,
    ["sign", "verify"],
  );
}

export async function signHmacBytes(input: {
  algorithm: HmacAlgorithm;
  secret: string;
  payload: Uint8Array;
}) {
  const key = await importHmacKey(input);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(input.payload)));
}

export async function verifyHmacSignature(input: {
  algorithm: HmacAlgorithm;
  secret: string;
  payload: Uint8Array;
  signature: Uint8Array;
}) {
  const key = await importHmacKey(input);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(input.signature),
    toArrayBuffer(input.payload),
  );
}

export async function digestEqual(first: Uint8Array, second: Uint8Array) {
  const [firstDigest, secondDigest] = await Promise.all([sha256Bytes(first), sha256Bytes(second)]);
  return equalLengthBytes(firstDigest, secondDigest);
}

function equalLengthBytes(first: Uint8Array, second: Uint8Array) {
  if (first.length !== second.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < first.length; index += 1) {
    diff |= first[index]! ^ second[index]!;
  }
  return diff === 0;
}

export async function timingSafeEqualText(first: string, second: string) {
  return await digestEqual(utf8Bytes(first), utf8Bytes(second));
}

export async function timingSafeEqualBytes(first: Uint8Array, second: Uint8Array) {
  return await digestEqual(first, second);
}
