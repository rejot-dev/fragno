import type { ProtocolEnvelope } from "@tanstack/db-sqlite-persistence-core";

import { parseStreamOffset } from "../consumer/stream-offset";
import {
  CHECKPOINT_SOURCE_ID,
  CHECKPOINT_TABLE_KEY,
  parseStreamCheckpoint,
  type StreamCheckpoint,
} from "../tanstack/state-sink";

export type StreamTerminalErrorMessage = {
  type: "fragno-stream:terminal-error";
  version: 1;
  ownerId: string;
  offset: string;
  error: {
    name: string;
    message: string;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createTerminalErrorMessage(options: {
  ownerId: string;
  offset: string;
  error: Error;
}): StreamTerminalErrorMessage {
  return {
    type: "fragno-stream:terminal-error",
    version: 1,
    ownerId: options.ownerId,
    offset: options.offset,
    error: { name: options.error.name, message: options.error.message },
  };
}

export function parseHeartbeatLeaderId(message: ProtocolEnvelope<unknown>): string | undefined {
  if (!isRecord(message.payload) || message.payload["type"] !== "leader:heartbeat") {
    return undefined;
  }
  const leaderId = message.payload["leaderId"];
  return typeof leaderId === "string" ? leaderId : undefined;
}

export function parseCommittedCheckpoint(
  message: ProtocolEnvelope<unknown>,
): StreamCheckpoint | undefined {
  if (
    !isRecord(message.payload) ||
    message.payload["type"] !== "tx:committed" ||
    message.payload["requiresFullReload"] !== false ||
    !Array.isArray(message.payload["changedRows"])
  ) {
    return undefined;
  }

  for (const changedRow of message.payload["changedRows"]) {
    if (!isRecord(changedRow) || !isRecord(changedRow["value"])) {
      continue;
    }
    const value = changedRow["value"];
    if (value["id"] === CHECKPOINT_SOURCE_ID && value["tableKey"] === CHECKPOINT_TABLE_KEY) {
      return parseStreamCheckpoint(
        value["checkpoint"],
        "coordinator committed checkpoint",
        parseStreamOffset,
      );
    }
  }
  return undefined;
}

export function parseTerminalError(
  message: ProtocolEnvelope<unknown>,
): { ownerId: string; offset: string; error: Error } | undefined {
  if (!isRecord(message.payload) || message.payload["type"] !== "fragno-stream:terminal-error") {
    return undefined;
  }
  const payload = message.payload;
  if (
    (payload["version"] !== undefined && payload["version"] !== 1) ||
    typeof payload["ownerId"] !== "string" ||
    typeof payload["offset"] !== "string" ||
    !isRecord(payload["error"]) ||
    typeof payload["error"]["name"] !== "string" ||
    typeof payload["error"]["message"] !== "string"
  ) {
    return undefined;
  }

  const error = new Error(payload["error"]["message"]);
  error.name = payload["error"]["name"];
  return {
    ownerId: payload["ownerId"],
    offset: parseStreamOffset(payload["offset"], "coordinator terminal error offset"),
    error,
  };
}
