import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { PiAgentDefinition, PiSession } from "./types";

export const PI_JSONL_EXPORT_CWD = "/workspace";

type PiJsonlSessionHeader = {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: typeof PI_JSONL_EXPORT_CWD;
};

type PiJsonlEntryBase = {
  id: string;
  parentId: string | null;
  timestamp: string;
};

type PiJsonlSessionInfoEntry = PiJsonlEntryBase & {
  type: "session_info";
  name: string;
};

type PiJsonlModelChangeEntry = PiJsonlEntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};

type PiJsonlThinkingLevelChangeEntry = PiJsonlEntryBase & {
  type: "thinking_level_change";
  thinkingLevel: NonNullable<PiAgentDefinition["thinkingLevel"]>;
};

type PiJsonlMessageEntry = PiJsonlEntryBase & {
  type: "message";
  message: AgentMessage;
};

export type PiJsonlExportLine =
  | PiJsonlSessionHeader
  | PiJsonlSessionInfoEntry
  | PiJsonlModelChangeEntry
  | PiJsonlThinkingLevelChangeEntry
  | PiJsonlMessageEntry;

type PiJsonlExportEntryInput =
  | Omit<PiJsonlSessionInfoEntry, "id" | "parentId">
  | Omit<PiJsonlModelChangeEntry, "id" | "parentId">
  | Omit<PiJsonlThinkingLevelChangeEntry, "id" | "parentId">
  | Omit<PiJsonlMessageEntry, "id" | "parentId">;

export type CreatePiJsonlExportInput = {
  session: PiSession;
  agent: PiAgentDefinition;
  messages: AgentMessage[];
};

const toIsoTimestamp = (
  value: Date | number | string | null | undefined,
  fallback: Date,
): string => {
  const date =
    value instanceof Date
      ? value
      : value === null || value === undefined
        ? fallback
        : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback.toISOString();
};

const messageTimestamp = (message: AgentMessage, session: PiSession): string => {
  const timestamp = "timestamp" in message ? message.timestamp : undefined;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return toIsoTimestamp(session.updatedAt, session.createdAt);
};

const entryId = (index: number): string => index.toString(16).padStart(8, "0");

const appendEntry = (entries: PiJsonlExportLine[], entry: PiJsonlExportEntryInput) => {
  const previous = entries.slice(1).at(-1);
  const id = entryId(entries.length);
  const parentId = previous && "id" in previous ? previous.id : null;

  switch (entry.type) {
    case "session_info":
      entries.push({ ...entry, id, parentId });
      break;
    case "model_change":
      entries.push({ ...entry, id, parentId });
      break;
    case "thinking_level_change":
      entries.push({ ...entry, id, parentId });
      break;
    case "message":
      entries.push({ ...entry, id, parentId });
      break;
  }
};

export const createPiJsonlExport = ({ session, agent, messages }: CreatePiJsonlExportInput) => {
  const sessionTimestamp = toIsoTimestamp(session.createdAt, new Date(0));
  const lines: PiJsonlExportLine[] = [
    {
      type: "session",
      version: 3,
      id: session.id,
      timestamp: sessionTimestamp,
      cwd: PI_JSONL_EXPORT_CWD,
    },
  ];

  if (session.name?.trim()) {
    appendEntry(lines, { type: "session_info", timestamp: sessionTimestamp, name: session.name });
  }

  appendEntry(lines, {
    type: "model_change",
    timestamp: sessionTimestamp,
    provider: agent.model.provider,
    modelId: agent.model.id,
  });

  if (agent.thinkingLevel) {
    appendEntry(lines, {
      type: "thinking_level_change",
      timestamp: sessionTimestamp,
      thinkingLevel: agent.thinkingLevel,
    });
  }

  for (const message of messages) {
    appendEntry(lines, {
      type: "message",
      timestamp: messageTimestamp(message, session),
      message,
    });
  }

  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
};
