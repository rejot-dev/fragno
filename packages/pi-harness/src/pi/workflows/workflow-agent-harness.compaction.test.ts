import { describe, test, assert } from "vitest";

import type { AgentMessage, CompactionPreparation } from "@earendil-works/pi-agent-core";

import { hasSummarizableCompactionHistory } from "./workflow-agent-harness";

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: 1,
});

const preparation = (overrides: Partial<CompactionPreparation> = {}): CompactionPreparation =>
  ({
    firstKeptEntryId: "entry-1",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    retainedTail: [],
    isSplitTurn: false,
    tokensBefore: 1_000,
    fileOps: { read: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    ...overrides,
  }) as CompactionPreparation;

describe("hasSummarizableCompactionHistory", () => {
  test("rejects a preparation that would retain the entire conversation", () => {
    assert(!hasSummarizableCompactionHistory(preparation()));
  });

  test("accepts ordinary history selected for summarization", () => {
    assert(
      hasSummarizableCompactionHistory(
        preparation({ messagesToSummarize: [userMessage("older history")] }),
      ),
    );
  });

  test("accepts the prefix of a split turn selected for summarization", () => {
    assert(
      hasSummarizableCompactionHistory(
        preparation({
          isSplitTurn: true,
          turnPrefixMessages: [userMessage("large turn prefix")],
        }),
      ),
    );
  });
});
