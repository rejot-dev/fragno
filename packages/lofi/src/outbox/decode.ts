import type { OutboxPayload } from "@fragno-dev/db";
import superjson, { type SuperJSONResult } from "superjson";

export function decodeOutboxPayload(payload: unknown): OutboxPayload {
  const decoded = superjson.deserialize(payload as SuperJSONResult);
  if (!isOutboxPayload(decoded)) {
    throw new Error("Invalid outbox payload");
  }

  for (const mutation of decoded.mutations) {
    const schema = mutation?.schema;
    if (typeof schema !== "string" || schema.trim().length === 0) {
      throw new Error("Outbox mutation schema is required");
    }
  }

  return decoded;
}

function isOutboxPayload(value: unknown): value is OutboxPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as OutboxPayload;
  return payload.version === 1 && Array.isArray(payload.mutations);
}
