import { describe, expect, test } from "vitest";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { estimatePiContextUsage, estimatePiMessageTokens } from "./context-usage";

const usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 10,
  totalTokens: 160,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistantMessage = (overrides: Partial<AssistantMessage> = {}): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "Completed response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage,
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  }) as AssistantMessage;

describe("estimatePiContextUsage", () => {
  test("uses the latest completed assistant usage and estimates trailing messages", () => {
    const trailingMessage = {
      role: "user",
      content: "12345678",
      timestamp: 2,
    } as AgentMessage;

    expect(estimatePiContextUsage([assistantMessage(), trailingMessage])).toEqual({
      tokens: 162,
      usageTokens: 160,
      trailingTokens: 2,
      lastUsageIndex: 0,
    });
  });

  test("estimates every message when provider usage is unavailable", () => {
    const messages = [
      { role: "user", content: "12345678", timestamp: 1 },
      assistantMessage({
        usage: { ...usage, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ] as AgentMessage[];

    expect(estimatePiContextUsage(messages)).toEqual({
      tokens: 7,
      usageTokens: 0,
      trailingTokens: 7,
      lastUsageIndex: null,
    });
  });

  test("ignores non-finite timestamps without losing valid assistant usage", () => {
    const nonFiniteUsage = assistantMessage({ timestamp: Number.NaN });
    const latestUsage = assistantMessage({
      timestamp: 2,
      usage: { ...usage, totalTokens: 200 },
    });

    expect(estimatePiContextUsage([nonFiniteUsage, latestUsage])).toEqual({
      tokens: 200,
      usageTokens: 200,
      trailingTokens: 0,
      lastUsageIndex: 1,
    });
    expect(estimatePiContextUsage([nonFiniteUsage])).toEqual({
      tokens: 160,
      usageTokens: 160,
      trailingTokens: 0,
      lastUsageIndex: 0,
    });
  });

  test("does not reuse pre-compaction usage for retained messages", () => {
    const messages = [
      {
        role: "compactionSummary",
        summary: "Compacted history",
        tokensBefore: 42_000,
        timestamp: 3,
      },
      { role: "user", content: "retained prompt", timestamp: 1 },
      assistantMessage({ timestamp: 2 }),
    ] as AgentMessage[];
    const estimatedTokens = messages.reduce(
      (total, message) => total + estimatePiMessageTokens(message),
      0,
    );

    expect(estimatePiContextUsage(messages)).toEqual({
      tokens: estimatedTokens,
      usageTokens: 0,
      trailingTokens: estimatedTokens,
      lastUsageIndex: null,
    });
  });
});

describe("estimatePiMessageTokens", () => {
  test("includes tool names and serialized arguments", () => {
    const message = assistantMessage({
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp" } }],
    });

    expect(estimatePiMessageTokens(message)).toBeGreaterThan(4);
  });
});
