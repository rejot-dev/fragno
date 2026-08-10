import superjson, { type SuperJSONResult } from "superjson";

import type { OutboxMatchScalar, OutboxPayload } from "@fragno-dev/db";

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
    if (operation.op === "truncate") {
      if (!isRecord(operation.match)) {
        throw new Error("Outbox truncate match must be an object");
      }
      if (!Object.values(operation.match).every(isOutboxMatchScalar)) {
        throw new Error("Outbox truncate match values must be scalars");
      }
      if (
        !Array.isArray(operation.externalIds) ||
        operation.externalIds.length === 0 ||
        !operation.externalIds.every(
          (externalId) => typeof externalId === "string" && externalId.length > 0,
        )
      ) {
        throw new Error("Outbox truncate external IDs must be non-empty strings");
      }
    }
  }

  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutboxMatchScalar(value: unknown): value is OutboxMatchScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  );
}

function isOutboxPayload(value: unknown): value is OutboxPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const payload = value as OutboxPayload;
  return payload.version === 2 && Array.isArray(payload.operations);
}
