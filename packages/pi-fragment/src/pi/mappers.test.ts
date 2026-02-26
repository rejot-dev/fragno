import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent, UserMessage } from "@mariozechner/pi-ai";

import {
  extractAssistantText,
  extractAssistantTextFromMessage,
  normalizeSteeringMode,
  normalizeTags,
  toId,
  toSessionOutput,
} from "./mappers";

const makeDate = (value: string) => new Date(value);

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const makeAssistantMessage = (
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai",
  model: "test-model",
  usage,
  stopReason: "stop",
  timestamp: 123,
  ...overrides,
});

const makeUserMessage = (
  content: UserMessage["content"],
  overrides: Partial<UserMessage> = {},
): UserMessage => ({
  role: "user",
  content,
  timestamp: 123,
  ...overrides,
});

describe("pi-fragment mappers", () => {
  it("normalizes steering mode values", () => {
    expect(normalizeSteeringMode("all")).toBe("all");
    expect(normalizeSteeringMode("one-at-a-time")).toBe("one-at-a-time");
    expect(normalizeSteeringMode("invalid")).toBe("one-at-a-time");
    expect(normalizeSteeringMode(undefined)).toBe("one-at-a-time");
  });

  it("filters tags to string entries", () => {
    expect(normalizeTags(["alpha", 123, null, "beta"])).toEqual(["alpha", "beta"]);
    expect(normalizeTags("nope")).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it("extracts the last assistant text block content", () => {
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ type: "text", text: "First" }]),
      makeUserMessage([{ type: "text", text: "User" }]),
      makeAssistantMessage([
        { type: "text", text: "Hello " } as TextContent,
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "world" } as TextContent,
      ]),
    ];

    expect(extractAssistantText(messages)).toBe("Hello world");
  });

  it("returns empty string when assistant content is missing or invalid", () => {
    expect(
      extractAssistantText([{ role: "assistant", content: "nope" } as unknown as AgentMessage]),
    ).toBe("");
    expect(extractAssistantText([makeUserMessage([{ type: "text", text: "hi" }])])).toBe("");
  });

  it("extracts assistant text from a single message", () => {
    expect(
      extractAssistantTextFromMessage(
        makeAssistantMessage([
          { type: "text", text: "  Trim " },
          { type: "text", text: " me" },
        ]),
      ),
    ).toBe("Trim  me");
    expect(extractAssistantTextFromMessage(null)).toBe("");
  });

  it("converts ids safely", () => {
    expect(toId("session-1")).toBe("session-1");
    expect(toId(null)).toBeNull();
    expect(toId({ valueOf: () => "session-2" })).toBe("session-2");
  });

  it("maps session rows into output shape with defaults", () => {
    const createdAt = makeDate("2024-01-02T03:04:05Z");
    const updatedAt = makeDate("2024-01-03T04:05:06Z");

    type SessionRow = Parameters<typeof toSessionOutput>[0];

    const output = toSessionOutput({
      id: { valueOf: () => "session-99" } as unknown as SessionRow["id"],
      name: null,
      status: "active",
      agent: undefined as unknown as SessionRow["agent"],
      workflowInstanceId: undefined as unknown as SessionRow["workflowInstanceId"],
      steeringMode: "invalid",
      metadata: undefined,
      tags: null,
      createdAt,
      updatedAt,
    } as unknown as SessionRow);

    expect(output).toEqual({
      id: "session-99",
      name: null,
      status: "active",
      agent: "unknown",
      workflowInstanceId: null,
      steeringMode: "one-at-a-time",
      metadata: null,
      tags: [],
      createdAt,
      updatedAt,
    });
  });
});
