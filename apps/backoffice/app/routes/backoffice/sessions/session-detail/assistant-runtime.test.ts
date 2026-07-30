import { assert, describe, expect, test } from "vitest";

import { createAssistantUiMessages } from "./assistant-runtime";
import { formatToolArgumentsDisplayText } from "./tool-arguments";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("formatToolArgumentsDisplayText", () => {
  test("renders streaming execCodeMode code input before the JSON argument is complete", () => {
    expect(
      formatToolArgumentsDisplayText({
        rawText:
          '{"code":"const path = \\"/tmp/example.txt\\";\\nawait state.writeFile(path, \\"hello',
        value: { code: "" },
      }),
    ).toContain('await state.writeFile(path, "hello');
  });
});

describe("createAssistantUiMessages", () => {
  test("converts thinking into reasoning and joins tool results to their calls", () => {
    const converted = createAssistantUiMessages({
      draftAgentMessage: null,
      readyForInput: true,
      statusText: null,
      messages: [
        { role: "user", content: "Inspect the repository", timestamp: 1 } as never,
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should inspect the files." },
            {
              type: "toolCall",
              id: "tool-read",
              name: "read",
              arguments: { path: "/tmp/example.ts" },
            },
            { type: "text", text: "I found the implementation." },
          ],
          timestamp: 2,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse",
        } as never,
        {
          role: "toolResult",
          toolCallId: "tool-read",
          toolName: "read",
          content: [{ type: "text", text: "export const value = true;" }],
          details: {},
          isError: false,
          timestamp: 3,
        } as never,
      ],
    });

    expect(converted).toHaveLength(2);
    const assistant = converted[1];
    assert.equal(assistant?.role, "assistant");
    expect(assistant?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "I should inspect the files." }),
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "tool-read",
          result: expect.objectContaining({ role: "toolResult", isError: false }),
        }),
        expect.objectContaining({ type: "text", text: "I found the implementation." }),
      ]),
    );
  });

  test("keeps the raw execCodeMode result in the tool-call artifact", () => {
    const rawResult = {
      total: 24,
      $ui: {
        version: 1,
        state: {},
        spec: {
          root: "metric",
          elements: {
            metric: {
              type: "Metric",
              props: { label: "Orders", value: "24" },
              children: [],
            },
          },
        },
      },
    };
    const converted = createAssistantUiMessages({
      draftAgentMessage: null,
      readyForInput: true,
      statusText: null,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-ui",
              name: "execCodeMode",
              arguments: { code: "async () => ({})" },
            },
          ],
          timestamp: 1,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse",
        } as never,
        {
          role: "toolResult",
          toolCallId: "tool-ui",
          toolName: "execCodeMode",
          content: [{ type: "text", text: JSON.stringify(rawResult) }],
          details: { result: rawResult, logs: [] },
          isError: false,
          timestamp: 2,
        } as never,
      ],
    });

    const toolPart = Array.isArray(converted[0]?.content)
      ? converted[0].content.find((part) => part.type === "tool-call")
      : null;
    expect(toolPart).toMatchObject({
      artifact: {
        completedToolResult: {
          details: { result: rawResult },
        },
      },
    });
  });

  test("marks only the last visible message as running", () => {
    const converted = createAssistantUiMessages({
      draftAgentMessage: null,
      readyForInput: false,
      statusText: "Working…",
      messages: [
        { role: "user", content: "First question", timestamp: 1 } as never,
        {
          role: "assistant",
          content: "First answer",
          timestamp: 2,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "stop",
        } as never,
        { role: "user", content: "Second question", timestamp: 3 } as never,
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-read",
              name: "read",
              arguments: { path: "/tmp/example.ts" },
            },
          ],
          timestamp: 4,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse",
        } as never,
        {
          role: "toolResult",
          toolCallId: "tool-read",
          toolName: "read",
          content: [{ type: "text", text: "example" }],
          details: {},
          isError: false,
          timestamp: 5,
        } as never,
      ],
    });

    const assistantMessages = converted.filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.status?.type)).toEqual([
      "complete",
      "running",
    ]);
  });

  test("adds a running assistant message for streamed reasoning and tools", () => {
    const converted = createAssistantUiMessages({
      readyForInput: false,
      statusText: "Running tool…",
      messages: [{ role: "user", content: "Run it", timestamp: 1 } as never],
      draftAgentMessage: {
        activity: "tool_calling",
        assistant: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "I will run the command." }],
          timestamp: 2,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse",
        },
        startedAt: 2,
        updatedAt: 3,
        tools: {
          "tool-bash": {
            id: "tool-bash",
            name: "bash",
            args: { command: "pnpm test" },
            status: "running",
          },
        },
      },
    });

    const pending = converted.at(-1);
    expect(pending).toMatchObject({ role: "assistant", status: { type: "running" } });
    expect(pending?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "I will run the command." }),
        expect.objectContaining({ type: "tool-call", toolCallId: "tool-bash" }),
      ]),
    );
  });

  test("keeps valid persisted and draft content visible around unsupported blocks", () => {
    const converted = createAssistantUiMessages({
      readyForInput: false,
      statusText: "Working…",
      messages: [
        {
          role: "user",
          content: [
            { type: "audio", data: "unsupported" },
            null,
            { type: "text", text: "Still visible" },
          ],
          timestamp: 1,
        } as never,
      ],
      draftAgentMessage: {
        activity: "thinking",
        assistant: {
          role: "assistant",
          content: [
            { type: "image", data: 42, mimeType: "image/png" },
            null,
            { type: "thinking", thinking: "Still reasoning" },
          ] as never,
          timestamp: 2,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse",
        },
        startedAt: 2,
        updatedAt: 3,
        tools: {},
      },
    });

    expect(converted[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining('"audio"') }),
        expect.objectContaining({ type: "text", text: "Still visible" }),
      ]),
    );
    expect(converted[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining('"image"') }),
        expect.objectContaining({ type: "reasoning", text: "Still reasoning" }),
      ]),
    );
  });

  test("keeps skill reads recognizable without exposing skill contents in the tool card", () => {
    const converted = createAssistantUiMessages({
      draftAgentMessage: null,
      readyForInput: true,
      statusText: null,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-read-skill",
              name: "read",
              arguments: { path: "/starter/skills/telegram-connection/SKILL.md" },
            },
          ],
          timestamp: 1,
          api: "test",
          provider: "test",
          model: "test",
          usage,
          stopReason: "toolUse",
        } as never,
        {
          role: "toolResult",
          toolCallId: "tool-read-skill",
          toolName: "read",
          content: [{ type: "text", text: "# Secret skill contents" }],
          details: { path: "/starter/skills/telegram-connection/SKILL.md" },
          isError: false,
          timestamp: 2,
        } as never,
      ],
    });

    const toolPart = Array.isArray(converted[0]?.content)
      ? converted[0].content.find((part) => part.type === "tool-call")
      : null;
    expect(toolPart).toMatchObject({
      toolName: "read",
      args: { path: "/starter/skills/telegram-connection/SKILL.md" },
    });
  });
});
