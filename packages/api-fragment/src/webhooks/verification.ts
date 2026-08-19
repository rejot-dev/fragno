import { z } from "zod";

const webhookRequestValueNameSchema = z.string().trim().min(1);

export const webhookRequestValueSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), name: webhookRequestValueNameSchema }),
  z.object({ type: z.literal("query"), name: webhookRequestValueNameSchema }),
  z.object({
    type: z.literal("jsonBodyPath"),
    path: z.array(z.string().trim().min(1)).min(1),
  }),
]);

const webhookVerificationPredicateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("present"),
    source: webhookRequestValueSourceSchema,
  }),
  z.object({
    type: z.literal("equals"),
    source: webhookRequestValueSourceSchema,
    value: z.string().min(1),
  }),
]);

export const webhookVerificationConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({
    type: z.literal("challenge"),
    method: z.enum(["GET", "POST"]),
    when: webhookVerificationPredicateSchema,
    response: z.object({
      type: z.literal("echoText"),
      source: webhookRequestValueSourceSchema,
    }),
  }),
]);

export type WebhookRequestValueSource = z.infer<typeof webhookRequestValueSourceSchema>;
export type WebhookVerificationConfig = z.infer<typeof webhookVerificationConfigSchema>;

export type WebhookJsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: "invalid_json" | "invalid_value" };

export type WebhookRequestValueResult =
  | { ok: true; value: string }
  | { ok: false; reason: "missing" | "invalid_json" | "invalid_value" };

export type WebhookRequestValues = {
  jsonBody(): WebhookJsonBodyResult;
  read(source: WebhookRequestValueSource): WebhookRequestValueResult;
};

export type WebhookVerificationResult =
  | { type: "not_verification" }
  | { type: "response"; body: string }
  | {
      type: "invalid_response";
      reason: "missing" | "invalid_json" | "invalid_value";
    };

export function createWebhookRequestValues(input: {
  headers: Headers;
  query: URLSearchParams;
  rawBody: string | undefined;
}): WebhookRequestValues {
  let parsedJsonBody: WebhookJsonBodyResult | undefined;

  function jsonBody(): WebhookJsonBodyResult {
    if (parsedJsonBody) {
      return parsedJsonBody;
    }

    let value: unknown;
    try {
      value = JSON.parse(input.rawBody ?? "");
    } catch {
      parsedJsonBody = { ok: false, reason: "invalid_json" };
      return parsedJsonBody;
    }

    parsedJsonBody = isJsonObject(value)
      ? { ok: true, body: value }
      : { ok: false, reason: "invalid_value" };
    return parsedJsonBody;
  }

  function read(source: WebhookRequestValueSource): WebhookRequestValueResult {
    if (source.type === "header") {
      return requestValue(input.headers.get(source.name));
    }
    if (source.type === "query") {
      return requestValue(input.query.get(source.name));
    }

    const body = jsonBody();
    if (!body.ok) {
      return body;
    }

    let value: unknown = body.body;
    for (const segment of source.path) {
      if (!isJsonObject(value) || !(segment in value)) {
        return { ok: false, reason: "missing" };
      }
      value = value[segment];
    }
    return requestValue(value);
  }

  return { jsonBody, read };
}

export function evaluateWebhookVerification(input: {
  config: WebhookVerificationConfig;
  method: "GET" | "POST";
  requestValues: WebhookRequestValues;
}): WebhookVerificationResult {
  if (input.config.type === "none" || input.config.method !== input.method) {
    return { type: "not_verification" };
  }

  const predicateValue = input.requestValues.read(input.config.when.source);
  if (!predicateValue.ok) {
    return { type: "not_verification" };
  }

  const matches =
    input.config.when.type === "present" || predicateValue.value === input.config.when.value;
  if (!matches) {
    return { type: "not_verification" };
  }

  const responseValue = input.requestValues.read(input.config.response.source);
  if (!responseValue.ok) {
    return { type: "invalid_response", reason: responseValue.reason };
  }

  return { type: "response", body: responseValue.value };
}

function requestValue(value: unknown): WebhookRequestValueResult {
  if (typeof value === "string") {
    return value.length > 0 ? { ok: true, value } : { ok: false, reason: "missing" };
  }
  if (typeof value === "number") {
    return { ok: true, value: `${value}` };
  }
  return value == null ? { ok: false, reason: "missing" } : { ok: false, reason: "invalid_value" };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
