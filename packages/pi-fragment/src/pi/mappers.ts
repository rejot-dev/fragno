import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TableToColumnValues } from "@fragno-dev/db/query";

import type { PiSteeringMode } from "./constants";
import { STEERING_MODES } from "./constants";
import type { PiSession } from "./types";
import { piSchema } from "../schema";

const toId = (value: { valueOf: () => string } | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return value.valueOf();
};

const normalizeSteeringMode = (value: unknown): PiSteeringMode => {
  return STEERING_MODES.includes(value as PiSteeringMode)
    ? (value as PiSteeringMode)
    : "one-at-a-time";
};

const normalizeTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
};

const extractAssistantText = (messages: AgentMessage[]): string => {
  const lastAssistant = [...messages].reverse().find((message) => {
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "assistant"
    );
  });

  if (!lastAssistant || typeof lastAssistant !== "object") {
    return "";
  }

  const content = (lastAssistant as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((block) => typeof block === "object" && block !== null && block.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("")
    .trim();
};

const extractAssistantTextFromMessage = (message?: AgentMessage | null): string => {
  if (!message) {
    return "";
  }
  return extractAssistantText([message]);
};

type SessionRow = TableToColumnValues<(typeof piSchema)["tables"]["session"]>;

const toSessionOutput = (row: SessionRow): PiSession => {
  return {
    id: toId(row.id) ?? "",
    name: row.name ?? null,
    status: row.status as PiSession["status"],
    agent: row.agent ?? "unknown",
    workflowInstanceId: row.workflowInstanceId ?? null,
    steeringMode: normalizeSteeringMode(row.steeringMode),
    metadata: row.metadata ?? null,
    tags: normalizeTags(row.tags),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

export {
  extractAssistantText,
  extractAssistantTextFromMessage,
  normalizeSteeringMode,
  normalizeTags,
  toId,
  toSessionOutput,
};
