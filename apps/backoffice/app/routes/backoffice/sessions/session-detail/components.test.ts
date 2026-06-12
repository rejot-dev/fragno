import { describe, expect, test } from "vitest";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { formatToolArgumentsDisplayText, SessionConversationPanel } from "./components";

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

describe("SessionConversationPanel", () => {
  test("renders assistant text content as Streamdown markdown", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionConversationPanel, {
        draftToolCalls: [],
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "# Plan\n\n- **Ship** markdown" }],
            timestamp: 1,
            api: "test",
            provider: "test",
            model: "test",
            usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: "stop",
          } as never,
        ],
        onJumpToLatest: () => {},
        onScroll: () => {},
        readyForInput: true,
        runningTools: [],
        scrollContentRef: createRef<HTMLDivElement>(),
        scrollViewportRef: createRef<HTMLDivElement>(),
        showJumpToLatest: false,
        showThinking: true,
        showToolCalls: true,
        showUsage: false,
        statusText: null,
      }),
    );

    expect(markup).toContain('data-streamdown="heading-1"');
    expect(markup).toContain('data-streamdown="unordered-list"');
    expect(markup).toContain('data-streamdown="strong"');
  });

  test("renders an expand control for execCodeMode results", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionConversationPanel, {
        draftToolCalls: [],
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tool-exec-code-mode",
                name: "execCodeMode",
                arguments: { code: "return { ok: true }" },
              },
            ],
            timestamp: 1,
            api: "test",
            provider: "test",
            model: "test",
            usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: "toolUse",
          } as never,
          {
            role: "toolResult",
            toolCallId: "tool-exec-code-mode",
            toolName: "execCodeMode",
            content: [{ type: "text", text: '{"ok":true}' }],
            details: { result: { ok: true }, logs: [] },
            isError: false,
            timestamp: 2,
          } as never,
        ],
        onJumpToLatest: () => {},
        onScroll: () => {},
        readyForInput: true,
        runningTools: [],
        scrollContentRef: createRef<HTMLDivElement>(),
        scrollViewportRef: createRef<HTMLDivElement>(),
        showJumpToLatest: false,
        showThinking: true,
        showToolCalls: true,
        showUsage: false,
        statusText: null,
      }),
    );

    expect(markup).toContain("Expand execCodeMode result");
    expect(markup).toContain("{&quot;ok&quot;:true}");
  });

  test("renders SKILL.md read tool results as loaded skills without file contents", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionConversationPanel, {
        draftToolCalls: [],
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
            usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
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
        onJumpToLatest: () => {},
        onScroll: () => {},
        readyForInput: true,
        runningTools: [],
        scrollContentRef: createRef<HTMLDivElement>(),
        scrollViewportRef: createRef<HTMLDivElement>(),
        showJumpToLatest: false,
        showThinking: true,
        showToolCalls: true,
        showUsage: false,
        statusText: null,
      }),
    );

    expect(markup).toContain("Skill loaded");
    expect(markup).toContain("telegram-connection");
    expect(markup).not.toContain("Secret skill contents");
    expect(markup).not.toContain("/starter/skills/telegram-connection/SKILL.md");
    expect(markup).not.toContain("Tool call · read");
  });

  test("renders a draft tool call even before the assistant message contains a tool block", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionConversationPanel, {
        draftToolCalls: [
          {
            key: "assistant:1:tool:0",
            contentIndex: 0,
            toolCallId: null,
            toolName: "execCodeMode",
            argumentsText: '{"code":"await state.writeFile(\\"/tmp/file.txt\\", \\"hello',
            argumentsValue: { code: 'await state.writeFile("/tmp/file.txt", "hello' },
            status: "streaming",
          },
        ],
        messages: [
          {
            role: "assistant",
            content: [],
            timestamp: 1,
            api: "test",
            provider: "test",
            model: "test",
            usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
            stopReason: "toolUse",
          } as never,
        ],
        onJumpToLatest: () => {},
        onScroll: () => {},
        readyForInput: false,
        runningTools: [],
        scrollContentRef: createRef<HTMLDivElement>(),
        scrollViewportRef: createRef<HTMLDivElement>(),
        showJumpToLatest: false,
        showThinking: true,
        showToolCalls: true,
        showUsage: false,
        statusText: "Writing tool call…",
      }),
    );

    expect(markup).toContain("Tool call · execCodeMode");
    expect(markup).toContain("Writing input");
    expect(markup).toContain("await state.writeFile(&quot;/tmp/file.txt&quot;, &quot;hello");
    expect(markup).not.toContain("Assistant is responding");
  });
});
