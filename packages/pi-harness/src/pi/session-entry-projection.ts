import {
  buildSessionContext,
  type AgentMessage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

import type { PiHarnessFrontendAgentMessage } from "./harness/agent-harness-event-protocol";
import { PiSessionDataIntegrityError } from "./types";
import type { PiHarnessStepResult } from "./workflows/workflow-agent-harness";

export type PiProjectionSessionIdentity = {
  workflowName: string;
  sessionId: string;
};

export type PersistedPiHarnessStepResult = PiHarnessStepResult & {
  outcome?: "completed" | "aborted";
  value?: unknown;
};

const dataIntegrityError = (
  identity: PiProjectionSessionIdentity,
  message: string,
  cause?: unknown,
): PiSessionDataIntegrityError =>
  new PiSessionDataIntegrityError(
    identity.workflowName,
    identity.sessionId,
    new Error(message, cause === undefined ? undefined : { cause }),
  );

/**
 * Workflow history exposes step results as `unknown`, but harness-run results are written by
 * `withWorkflowAgentHarness`. This is the single trust boundary for that internally owned data.
 */
export const asPersistedPiHarnessStepResult = (
  value: unknown,
): PersistedPiHarnessStepResult | null => {
  const result = value as PersistedPiHarnessStepResult | undefined;
  return result?.type === "harness-run" ? result : null;
};

export const mergePiSessionEntries = (
  ...entryGroups: readonly (readonly SessionTreeEntry[])[]
): SessionTreeEntry[] => {
  const entries: SessionTreeEntry[] = [];
  const indexes = new Map<string, number>();

  for (const entryGroup of entryGroups) {
    for (const entry of entryGroup) {
      const index = indexes.get(entry.id);
      if (index === undefined) {
        indexes.set(entry.id, entries.length);
        entries.push(entry);
      } else {
        entries[index] = entry;
      }
    }
  }

  return entries;
};

export const latestCompletedPiHarnessEntries = (
  steps: readonly { status: string; result: unknown }[],
): SessionTreeEntry[] =>
  mergePiSessionEntries(
    ...steps.flatMap((step) => {
      if (step.status !== "completed") {
        return [];
      }
      const result = asPersistedPiHarnessStepResult(step.result);
      return result ? [result.appendedEntries] : [];
    }),
  );

const resolveActiveSessionPath = (
  entries: readonly SessionTreeEntry[],
  identity: PiProjectionSessionIdentity,
): SessionTreeEntry[] => {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }
  if (leafId === null) {
    return [];
  }

  const entriesById = new Map<string, SessionTreeEntry>();
  for (const entry of entries) {
    if (entriesById.has(entry.id)) {
      throw dataIntegrityError(identity, `Pi session tree contains duplicate entry ${entry.id}.`);
    }
    entriesById.set(entry.id, entry);
  }
  const reversePath: SessionTreeEntry[] = [];
  const visitedEntryIds = new Set<string>();
  let currentId: string | null = leafId;

  while (currentId !== null) {
    if (visitedEntryIds.has(currentId)) {
      throw dataIntegrityError(
        identity,
        `Pi session tree contains a parent cycle at ${currentId}.`,
      );
    }
    visitedEntryIds.add(currentId);

    const entry = entriesById.get(currentId);
    if (!entry) {
      throw dataIntegrityError(identity, `Pi session tree references missing entry ${currentId}.`);
    }
    reversePath.push(entry);
    currentId = entry.parentId;
  }

  return reversePath.reverse();
};

export type ProjectedPiSessionEntries = {
  contextMessages: AgentMessage[];
  timelineMessages: PiHarnessFrontendAgentMessage[];
};

export type ProjectPiSessionEntriesOptions = {
  timelineMessagesAfterEntryId?: ReadonlyMap<
    string | null,
    readonly PiHarnessFrontendAgentMessage[]
  >;
};

export const projectPiSessionEntries = (
  entries: readonly SessionTreeEntry[],
  identity: PiProjectionSessionIdentity,
  options: ProjectPiSessionEntriesOptions = {},
): ProjectedPiSessionEntries => {
  const activePath = resolveActiveSessionPath(entries, identity);

  let contextMessages: AgentMessage[];
  try {
    contextMessages = buildSessionContext(activePath).messages;
  } catch (error) {
    throw dataIntegrityError(identity, "Pi session entries cannot build a valid context.", error);
  }

  const timelineMessages: PiHarnessFrontendAgentMessage[] = [
    ...(options.timelineMessagesAfterEntryId?.get(null) ?? []),
  ];
  for (const entry of activePath) {
    if (entry.type === "message") {
      timelineMessages.push(entry.message);
    } else if (entry.type === "compaction") {
      timelineMessages.push({
        role: "compactionSummary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        timestamp: new Date(entry.timestamp).getTime(),
      });
    }
    timelineMessages.push(...(options.timelineMessagesAfterEntryId?.get(entry.id) ?? []));
  }

  return { contextMessages, timelineMessages };
};
