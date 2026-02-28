const BASE64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const HEX_TABLE = "0123456789abcdef";

function getCrypto() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    throw new Error("Web Crypto API is not available in this environment.");
  }
  return cryptoApi;
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error("randomBytes length must be a positive number.");
  }
  const bytes = new Uint8Array(length);
  getCrypto().getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  let i = 0;

  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    output +=
      BASE64_TABLE[(chunk >> 18) & 63] +
      BASE64_TABLE[(chunk >> 12) & 63] +
      BASE64_TABLE[(chunk >> 6) & 63] +
      BASE64_TABLE[chunk & 63];
  }

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    output += BASE64_TABLE[(chunk >> 18) & 63] + BASE64_TABLE[(chunk >> 12) & 63] + "==";
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    output +=
      BASE64_TABLE[(chunk >> 18) & 63] +
      BASE64_TABLE[(chunk >> 12) & 63] +
      BASE64_TABLE[(chunk >> 6) & 63] +
      "=";
  }

  return output;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += HEX_TABLE[byte >> 4] + HEX_TABLE[byte & 15];
  }
  return output;
}
