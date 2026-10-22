import { validateFileKey, type FileKey } from "./file-key";
import { getStaticGlobPrefix, globToRegExp } from "./text-index";

export type FileLinksConfig = {
  /** Signs links. Rotating it invalidates every outstanding link. */
  secret: string;
  /**
   * Names the file namespace this instance serves. A link verifies only on instances with the same
   * secret and audience, so instances that share a secret need distinct audiences.
   */
  audience: string;
  /** Content type of files written through links, whose requests carry no trustworthy type. */
  contentTypeForKey: (fileKey: FileKey) => string;
  /**
   * Most files one uploaded archive may write. An archive publishes as one prepared batch, so values
   * above the batch limit (5,000) act as the batch limit.
   */
  maxArchiveWriteFiles: number;
  /** Most bytes, summed over its files, one uploaded archive may write. */
  maxArchiveWriteBytes: number;
};

export type FileLinkAccess = "read" | "write";

/** One file, or every file key the glob matches. */
export type FileLinkTarget = { kind: "file"; fileKey: FileKey } | { kind: "glob"; glob: string };

export type FileLinkGrant = {
  provider: string;
  access: FileLinkAccess;
  target: FileLinkTarget;
  expiresAtEpochMs: number;
};

export type FileLinkVerification =
  | { status: "valid"; grant: FileLinkGrant }
  | { status: "expired" }
  | { status: "invalid" };

const TOKEN_VERSION = 1;
const SIGNATURE_PREFIX = "fragno-upload-file-link-v1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    return null;
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function signingInput(audience: string, encodedPayload: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${SIGNATURE_PREFIX}\n${audience}\n${encodedPayload}`);
}

export async function signFileLink(config: FileLinksConfig, grant: FileLinkGrant): Promise<string> {
  const encodedPayload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ version: TOKEN_VERSION, ...grant })),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importSigningKey(config.secret),
    signingInput(config.audience, encodedPayload),
  );
  return `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyFileLink(
  config: FileLinksConfig,
  token: string,
  nowEpochMs: number,
): Promise<FileLinkVerification> {
  const [encodedPayload, encodedSignature, ...rest] = token.split(".");
  const signature = encodedSignature === undefined ? null : base64UrlDecode(encodedSignature);
  if (!encodedPayload || !signature || rest.length > 0) {
    return { status: "invalid" };
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    await importSigningKey(config.secret),
    Uint8Array.from(signature),
    signingInput(config.audience, encodedPayload),
  );
  if (!verified) {
    return { status: "invalid" };
  }
  // A verified payload is one this instance signed, so it is authoritative.
  const { version, ...grant } = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(encodedPayload)!),
  ) as FileLinkGrant & { version: number };
  if (version !== TOKEN_VERSION) {
    return { status: "invalid" };
  }
  return grant.expiresAtEpochMs > nowEpochMs ? { status: "valid", grant } : { status: "expired" };
}

/** Glob links address files by their path below the glob's static directory prefix. */
export function fileLinkGlobBase(glob: string): string {
  return getStaticGlobPrefix(glob);
}

export function isFileLinkGlob(glob: string): boolean {
  return /[*?]/u.test(glob) && !glob.startsWith("/");
}

/** Resolves the file key a glob link addresses by relative path, or null outside the glob. */
export function resolveFileLinkGlobKey(glob: string, relativePath: string): FileKey | null {
  const fileKey = `${fileLinkGlobBase(glob)}${relativePath}`;
  return validateFileKey(fileKey).valid && globToRegExp(glob).test(fileKey) ? fileKey : null;
}

export function fileLinkGlobMatches(glob: string, fileKey: FileKey): boolean {
  return globToRegExp(glob).test(fileKey);
}
