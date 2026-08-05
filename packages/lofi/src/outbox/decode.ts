import superjson, { type SuperJSONResult } from "superjson";

import type { OutboxPayload } from "@fragno-dev/db";

export function decodeOutboxPayload(payload: unknown): OutboxPayload {
  const decoded = superjson.deserialize(payload as SuperJSONResult);
  if (!isOutboxPayload(decoded)) {
    throw new Error("Invalid outbox payload");
  }

  for (const operation of decoded.operations) {
    const schema = operation?.schema;
    if (typeof schema !== "string" || schema.trim().length === 0) {
      throw new Error("Outbox operation schema is required");
    }
  }

  return decoded;
}

function isOutboxPayload(value: unknown): value is OutboxPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as OutboxPayload;
  return payload.version === 2 && Array.isArray(payload.operations);
}
