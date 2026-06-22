import { z } from "zod";

import {
  decodeBase64,
  decodeBase64ToText,
  decodeHex,
  timingSafeEqualText as verifySecretText,
  utf8Bytes,
  verifyHmacSignature,
} from "../crypto";

const secretRefSchema = z.string().trim().min(1);
const requestValueNameSchema = z.string().trim().min(1);

export const webhookAuthConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("bearer"), tokenRef: secretRefSchema }),
  z.object({
    type: z.literal("apiKey"),
    location: z.enum(["header", "query"]),
    name: requestValueNameSchema,
    secretRef: secretRefSchema,
  }),
  z.object({
    type: z.literal("basic"),
    usernameRef: secretRefSchema,
    passwordRef: secretRefSchema,
  }),
  z.object({
    type: z.literal("hmac"),
    secretRef: secretRefSchema,
    algorithm: z.enum(["sha1", "sha256", "sha512"]),
    signature: z.object({
      location: z.enum(["header", "query"]),
      name: requestValueNameSchema,
      encoding: z.enum(["hex", "base64", "base64url"]),
      prefix: z.string().optional(),
    }),
    signedPayload: z.discriminatedUnion("type", [
      z.object({ type: z.literal("rawBody") }),
      z.object({
        type: z.literal("timestampBody"),
        timestampHeader: requestValueNameSchema,
        delimiter: z.string(),
        toleranceSeconds: z.number().int().positive(),
      }),
    ]),
  }),
]);

export type WebhookAuthConfig = z.infer<typeof webhookAuthConfigSchema>;
export type WebhookAuthType = WebhookAuthConfig["type"];
export type WebhookAuthSecretRef = string;

export type WebhookSecretResolver = {
  get(ref: WebhookAuthSecretRef): string | undefined | Promise<string | undefined>;
};

export type WebhookAuthFailureReason =
  | "missing_secret"
  | "missing_credential"
  | "invalid_credential"
  | "timestamp_out_of_range"
  | "bad_config";

export type WebhookAuthResult = { ok: true } | { ok: false; reason: WebhookAuthFailureReason };

export type SensitiveRequestValue = {
  location: "header" | "query";
  name: string;
};

export type WebhookAuthVerificationContext = {
  request: Request;
  now: Date;
  secrets: WebhookSecretResolver;
  rawBodyBytes(): Promise<Uint8Array>;
};

export interface WebhookAuthVerifier<TConfig extends WebhookAuthConfig> {
  type: TConfig["type"];
  requiredSecretRefs(config: TConfig): readonly WebhookAuthSecretRef[];
  sensitiveRequestValues(config: TConfig): readonly SensitiveRequestValue[];
  verify(config: TConfig, context: WebhookAuthVerificationContext): Promise<WebhookAuthResult>;
}

type WebhookAuthVerifierRegistry = {
  [TType in WebhookAuthType]: WebhookAuthVerifier<Extract<WebhookAuthConfig, { type: TType }>>;
};

export type VerifyWebhookAuthInput = {
  config: WebhookAuthConfig;
  /** Pass the original web-standard Request or a clone. The body is read from request.clone(). */
  request: Request;
  secrets: WebhookSecretResolver;
  now?: Date;
};

const getHeaderAuthorizationCredential = (request: Request, scheme: "basic" | "bearer") => {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }

  const [headerScheme, ...rest] = header.split(/\s+/);
  if (headerScheme?.toLowerCase() !== scheme || rest.length === 0) {
    return null;
  }

  return rest.join(" ");
};

const getRequestValue = (
  request: Request,
  location: "header" | "query",
  name: string,
): string | null => {
  if (location === "header") {
    return request.headers.get(name);
  }

  return new URL(request.url).searchParams.get(name);
};

type WebhookAuthFailure = Extract<WebhookAuthResult, { ok: false }>;

type ResolvedSecret = WebhookAuthFailure | { ok: true; secret: string };

const requireSecret = async (
  context: WebhookAuthVerificationContext,
  ref: WebhookAuthSecretRef,
): Promise<ResolvedSecret> => {
  const secret = await context.secrets.get(ref);
  if (!secret) {
    return { ok: false, reason: "missing_secret" };
  }

  return { ok: true, secret };
};

const noneVerifier: WebhookAuthVerifier<Extract<WebhookAuthConfig, { type: "none" }>> = {
  type: "none",
  requiredSecretRefs: () => [],
  sensitiveRequestValues: () => [],
  verify: async () => ({ ok: true }),
};

const bearerVerifier: WebhookAuthVerifier<Extract<WebhookAuthConfig, { type: "bearer" }>> = {
  type: "bearer",
  requiredSecretRefs: (config) => [config.tokenRef],
  sensitiveRequestValues: () => [{ location: "header", name: "authorization" }],
  verify: async (config, context) => {
    const secret = await requireSecret(context, config.tokenRef);
    if (!secret.ok) {
      return secret;
    }

    const token = getHeaderAuthorizationCredential(context.request, "bearer");
    if (!token) {
      return { ok: false, reason: "missing_credential" };
    }

    return (await verifySecretText(token, secret.secret))
      ? { ok: true }
      : { ok: false, reason: "invalid_credential" };
  },
};

const apiKeyVerifier: WebhookAuthVerifier<Extract<WebhookAuthConfig, { type: "apiKey" }>> = {
  type: "apiKey",
  requiredSecretRefs: (config) => [config.secretRef],
  sensitiveRequestValues: (config) => [{ location: config.location, name: config.name }],
  verify: async (config, context) => {
    const secret = await requireSecret(context, config.secretRef);
    if (!secret.ok) {
      return secret;
    }

    const credential = getRequestValue(context.request, config.location, config.name);
    if (!credential) {
      return { ok: false, reason: "missing_credential" };
    }

    return (await verifySecretText(credential, secret.secret))
      ? { ok: true }
      : { ok: false, reason: "invalid_credential" };
  },
};

const basicVerifier: WebhookAuthVerifier<Extract<WebhookAuthConfig, { type: "basic" }>> = {
  type: "basic",
  requiredSecretRefs: (config) => [config.usernameRef, config.passwordRef],
  sensitiveRequestValues: () => [{ location: "header", name: "authorization" }],
  verify: async (config, context) => {
    const username = await requireSecret(context, config.usernameRef);
    if (!username.ok) {
      return username;
    }
    const password = await requireSecret(context, config.passwordRef);
    if (!password.ok) {
      return password;
    }

    const encodedCredential = getHeaderAuthorizationCredential(context.request, "basic");
    if (!encodedCredential) {
      return { ok: false, reason: "missing_credential" };
    }

    const decodedCredential = decodeBase64ToText(encodedCredential, "base64");
    if (decodedCredential === null) {
      return { ok: false, reason: "invalid_credential" };
    }

    const separatorIndex = decodedCredential.indexOf(":");
    if (separatorIndex === -1) {
      return { ok: false, reason: "invalid_credential" };
    }

    const actualUsername = decodedCredential.slice(0, separatorIndex);
    const actualPassword = decodedCredential.slice(separatorIndex + 1);

    return (await verifySecretText(actualUsername, username.secret)) &&
      (await verifySecretText(actualPassword, password.secret))
      ? { ok: true }
      : { ok: false, reason: "invalid_credential" };
  },
};

const hmacVerifier: WebhookAuthVerifier<Extract<WebhookAuthConfig, { type: "hmac" }>> = {
  type: "hmac",
  requiredSecretRefs: (config) => [config.secretRef],
  sensitiveRequestValues: (config) => [
    { location: config.signature.location, name: config.signature.name },
  ],
  verify: async (config, context) => {
    const secret = await requireSecret(context, config.secretRef);
    if (!secret.ok) {
      return secret;
    }

    const signatureValue = getRequestValue(
      context.request,
      config.signature.location,
      config.signature.name,
    );
    if (!signatureValue) {
      return { ok: false, reason: "missing_credential" };
    }

    const normalizedSignature = normalizeSignature(signatureValue, config.signature.prefix);
    if (normalizedSignature === null) {
      return { ok: false, reason: "invalid_credential" };
    }

    const signedPayload = await buildSignedPayload(config, context);
    if (!signedPayload.ok) {
      return signedPayload;
    }

    const providedSignature = decodeSignature(normalizedSignature, config.signature.encoding);
    if (!providedSignature) {
      return { ok: false, reason: "invalid_credential" };
    }

    return (await verifyHmacSignature({
      algorithm: config.algorithm,
      secret: secret.secret,
      payload: signedPayload.payload,
      signature: providedSignature,
    }))
      ? { ok: true }
      : { ok: false, reason: "invalid_credential" };
  },
};

export const webhookAuthVerifiers = {
  none: noneVerifier,
  bearer: bearerVerifier,
  apiKey: apiKeyVerifier,
  basic: basicVerifier,
  hmac: hmacVerifier,
} satisfies WebhookAuthVerifierRegistry;

export async function verifyWebhookAuth({
  config,
  request,
  secrets,
  now = new Date(),
}: VerifyWebhookAuthInput): Promise<WebhookAuthResult> {
  const verifier = getWebhookAuthVerifier(config);
  let rawBodyBytes: Uint8Array | null = null;

  return await verifier.verify(config, {
    request,
    now,
    secrets,
    rawBodyBytes: async () => {
      rawBodyBytes ??= new Uint8Array(await request.clone().arrayBuffer());
      return rawBodyBytes;
    },
  });
}

export function getWebhookAuthSecretRefs(
  config: WebhookAuthConfig,
): readonly WebhookAuthSecretRef[] {
  return getWebhookAuthVerifier(config).requiredSecretRefs(config);
}

export function getSensitiveWebhookAuthValues(
  config: WebhookAuthConfig,
): readonly SensitiveRequestValue[] {
  return getWebhookAuthVerifier(config).sensitiveRequestValues(config);
}

function getWebhookAuthVerifier<TConfig extends WebhookAuthConfig>(
  config: TConfig,
): WebhookAuthVerifier<TConfig> {
  return webhookAuthVerifiers[config.type] as WebhookAuthVerifier<TConfig>;
}

async function buildSignedPayload(
  config: Extract<WebhookAuthConfig, { type: "hmac" }>,
  context: WebhookAuthVerificationContext,
): Promise<{ ok: true; payload: Uint8Array } | WebhookAuthFailure> {
  if (config.signedPayload.type === "rawBody") {
    return { ok: true, payload: await context.rawBodyBytes() };
  }

  const timestamp = context.request.headers.get(config.signedPayload.timestampHeader);
  if (!timestamp) {
    return { ok: false, reason: "missing_credential" };
  }

  const timestampMs = parseWebhookTimestampMs(timestamp);
  if (timestampMs === null) {
    return { ok: false, reason: "invalid_credential" };
  }

  const toleranceMs = config.signedPayload.toleranceSeconds * 1000;
  if (Math.abs(context.now.getTime() - timestampMs) > toleranceMs) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  return {
    ok: true,
    payload: concatBytes(
      utf8Bytes(`${timestamp}${config.signedPayload.delimiter}`),
      await context.rawBodyBytes(),
    ),
  };
}

function normalizeSignature(signature: string, prefix: string | undefined) {
  const trimmed = signature.trim();
  if (!prefix) {
    return trimmed || null;
  }

  if (!trimmed.startsWith(prefix)) {
    return null;
  }

  const withoutPrefix = trimmed.slice(prefix.length).trim();
  return withoutPrefix || null;
}

function decodeSignature(signature: string, encoding: "hex" | "base64" | "base64url") {
  if (encoding === "hex") {
    return decodeHex(signature);
  }

  return decodeBase64(signature, encoding);
}

function parseWebhookTimestampMs(value: string) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const numeric = Number(normalized);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return null;
  }

  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function concatBytes(first: Uint8Array, second: Uint8Array) {
  const output = new Uint8Array(first.length + second.length);
  output.set(first, 0);
  output.set(second, first.length);
  return output;
}

export { timingSafeEqualBytes, timingSafeEqualText } from "../crypto";
