import { z } from "zod";

import { resolveLiveAccessTokenSecret } from "@/fragno/auth/contracts";

import {
  backofficeContextScopesEqual,
  backofficeExecutionContextSchema,
  type BackofficeExecutionContext,
} from "./context";
import {
  encodeBackofficeObjectAddress,
  objectScopeToContextScope,
  type BackofficeObjectAddress,
} from "./object-registry";

export const BACKOFFICE_INTERNAL_CONTEXT_HEADER = "x-backoffice-internal-context";

const INTERNAL_CONTEXT_VERSION = 1;
const INTERNAL_CONTEXT_LIFETIME_MS = 30_000;
const INTERNAL_CONTEXT_CLOCK_SKEW_MS = 5_000;
const INTERNAL_CONTEXT_SIGNATURE_PREFIX = "backoffice-internal-context-v1.";

const backofficeInternalContextPayloadSchema = z.strictObject({
  version: z.literal(INTERNAL_CONTEXT_VERSION),
  binding: z.string().trim().min(1),
  objectName: z.string().trim().min(1),
  method: z.string().trim().min(1),
  pathname: z.string().startsWith("/"),
  search: z.string(),
  execution: backofficeExecutionContextSchema,
  propagationContext: z.record(z.string(), z.string()).nullable(),
  issuedAtEpochMs: z.number().int().nonnegative(),
  expiresAtEpochMs: z.number().int().positive(),
  requestId: z.uuid(),
});

type BackofficeInternalContextPayload = z.infer<typeof backofficeInternalContextPayloadSchema>;

export type BackofficeAuthorizedRequestContext = {
  execution: BackofficeExecutionContext;
  propagationContext: Readonly<Record<string, string>> | null;
};

export type VerifiedBackofficeInternalRequest = {
  request: Request;
  context: BackofficeAuthorizedRequestContext;
  requestId: string;
};

export class BackofficeInternalRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackofficeInternalRequestError";
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch (cause) {
    throw new BackofficeInternalRequestError("Backoffice internal request encoding is invalid.", {
      cause,
    });
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function resolveInternalContextSecret(
  env: Pick<CloudflareEnv, "AUTH_ACCESS_TOKEN_SECRET">,
): string {
  return resolveLiveAccessTokenSecret(
    env as CloudflareEnv,
    import.meta.env?.MODE === "development" || import.meta.env?.MODE === "test",
  );
}

async function importInternalContextSigningKey(
  env: Pick<CloudflareEnv, "AUTH_ACCESS_TOKEN_SECRET">,
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(new TextEncoder().encode(resolveInternalContextSecret(env))).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function internalContextSigningInput(encodedPayload: string): ArrayBuffer {
  return Uint8Array.from(
    new TextEncoder().encode(`${INTERNAL_CONTEXT_SIGNATURE_PREFIX}${encodedPayload}`),
  ).buffer;
}

async function signInternalContextPayload(
  env: Pick<CloudflareEnv, "AUTH_ACCESS_TOKEN_SECRET">,
  encodedPayload: string,
): Promise<string> {
  const key = await importInternalContextSigningKey(env);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    internalContextSigningInput(encodedPayload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyInternalContextSignature(
  env: Pick<CloudflareEnv, "AUTH_ACCESS_TOKEN_SECRET">,
  encodedPayload: string,
  encodedSignature: string,
): Promise<boolean> {
  const key = await importInternalContextSigningKey(env);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(base64UrlDecode(encodedSignature)).buffer,
    internalContextSigningInput(encodedPayload),
  );
}

function parseInternalContextPayload(encodedPayload: string): BackofficeInternalContextPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  } catch (cause) {
    throw new BackofficeInternalRequestError("Backoffice internal request payload is invalid.", {
      cause,
    });
  }

  const parsed = backofficeInternalContextPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BackofficeInternalRequestError("Backoffice internal request payload is invalid.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function removeBackofficeInternalContextHeader(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(BACKOFFICE_INTERNAL_CONTEXT_HEADER);
  return new Request(request, { headers });
}

/** Signs trusted execution provenance for one native Durable Object fetch request. */
export async function createAuthorizedBackofficeObjectRequest({
  request,
  address,
  context,
  env,
  nowEpochMs = Date.now(),
  requestId = crypto.randomUUID(),
}: {
  request: Request;
  address: BackofficeObjectAddress;
  context: BackofficeAuthorizedRequestContext;
  env: Pick<CloudflareEnv, "AUTH_ACCESS_TOKEN_SECRET">;
  nowEpochMs?: number;
  requestId?: string;
}): Promise<Request> {
  const url = new URL(request.url);
  const payload: BackofficeInternalContextPayload = {
    version: INTERNAL_CONTEXT_VERSION,
    binding: address.binding,
    objectName: encodeBackofficeObjectAddress(address),
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    execution: context.execution,
    propagationContext: context.propagationContext,
    issuedAtEpochMs: nowEpochMs,
    expiresAtEpochMs: nowEpochMs + INTERNAL_CONTEXT_LIFETIME_MS,
    requestId,
  };
  const encodedPayload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(backofficeInternalContextPayloadSchema.parse(payload))),
  );
  const signature = await signInternalContextPayload(env, encodedPayload);
  const headers = new Headers(request.headers);
  headers.delete(BACKOFFICE_INTERNAL_CONTEXT_HEADER);
  headers.set(BACKOFFICE_INTERNAL_CONTEXT_HEADER, `${encodedPayload}.${signature}`);
  return new Request(request, { headers });
}

/** Verifies and removes the trusted execution envelope from a native Durable Object request. */
export async function verifyAuthorizedBackofficeObjectRequest({
  request,
  address,
  env,
  nowEpochMs = Date.now(),
}: {
  request: Request;
  address: BackofficeObjectAddress;
  env: Pick<CloudflareEnv, "AUTH_ACCESS_TOKEN_SECRET">;
  nowEpochMs?: number;
}): Promise<VerifiedBackofficeInternalRequest> {
  const envelope = request.headers.get(BACKOFFICE_INTERNAL_CONTEXT_HEADER);
  if (!envelope) {
    throw new BackofficeInternalRequestError("Backoffice internal request context is missing.");
  }

  const segments = envelope.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new BackofficeInternalRequestError("Backoffice internal request context is malformed.");
  }
  const [encodedPayload, encodedSignature] = segments;
  if (!(await verifyInternalContextSignature(env, encodedPayload, encodedSignature))) {
    throw new BackofficeInternalRequestError("Backoffice internal request signature is invalid.");
  }

  const payload = parseInternalContextPayload(encodedPayload);
  const requestUrl = new URL(request.url);
  if (
    payload.binding !== address.binding ||
    payload.objectName !== encodeBackofficeObjectAddress(address) ||
    payload.method !== request.method ||
    payload.pathname !== requestUrl.pathname ||
    payload.search !== requestUrl.search
  ) {
    throw new BackofficeInternalRequestError(
      "Backoffice internal request context does not match its request target.",
    );
  }
  if (
    payload.issuedAtEpochMs > nowEpochMs + INTERNAL_CONTEXT_CLOCK_SKEW_MS ||
    payload.expiresAtEpochMs <= nowEpochMs ||
    payload.expiresAtEpochMs - payload.issuedAtEpochMs > INTERNAL_CONTEXT_LIFETIME_MS
  ) {
    throw new BackofficeInternalRequestError("Backoffice internal request context has expired.");
  }

  const objectScope = objectScopeToContextScope(address.scope);
  if (!backofficeContextScopesEqual(payload.execution.scope, objectScope)) {
    throw new BackofficeInternalRequestError(
      "Backoffice internal request execution scope does not match the object address.",
    );
  }

  return {
    request: removeBackofficeInternalContextHeader(request),
    context: {
      execution: payload.execution,
      propagationContext: payload.propagationContext,
    },
    requestId: payload.requestId,
  };
}
