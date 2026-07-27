const copyToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (content: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", copyToArrayBuffer(content));
  return bytesToHex(new Uint8Array(digest));
};
