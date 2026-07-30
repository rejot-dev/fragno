import { describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolResultContent } from "./tool-call";

const rawResult = {
  total: 24,
  $ui: {
    version: 1,
    state: { total: 24 },
    spec: {
      root: "report",
      elements: {
        report: {
          type: "Stack",
          props: { gap: "sm" },
          children: ["metric"],
        },
        metric: {
          type: "Metric",
          props: { label: "Orders", value: "24" },
          children: [],
        },
      },
    },
  },
};

const toolResult = {
  role: "toolResult",
  toolCallId: "tool-ui",
  toolName: "execCodeMode",
  content: [{ type: "text", text: "raw-sidecar-marker" }],
  details: { result: rawResult, logs: ["log-sidecar-marker"] },
  isError: false,
  timestamp: 1,
} as never;

describe("ToolResultContent", () => {
  test("chooses generated UI for an execCodeMode result with a valid $ui sidecar", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolResultContent, {
        expanded: false,
        hasRawResult: true,
        rawResult,
        result: toolResult,
        useExecCodeModeFormatting: true,
      }),
    );

    expect(markup).toContain('aria-label="Orders"');
    expect(markup).toContain(">24</p>");
    expect(markup).not.toContain("raw-sidecar-marker");
    expect(markup).not.toContain("log-sidecar-marker");
  });

  test("renders only the returned value when codemode logs are presented separately", () => {
    const ordinaryResult = {
      role: "toolResult",
      toolCallId: "tool-ordinary",
      toolName: "execCodeMode",
      content: [{ type: "text", text: "log-sidecar-marker\nordinary-value" }],
      details: { result: "ordinary-value", logs: ["log-sidecar-marker"] },
      isError: false,
      timestamp: 1,
    } as never;
    const markup = renderToStaticMarkup(
      createElement(ToolResultContent, {
        expanded: false,
        hasRawResult: true,
        rawResult: "ordinary-value",
        result: ordinaryResult,
        useExecCodeModeFormatting: true,
      }),
    );

    expect(markup).not.toContain("log-sidecar-marker");
    expect(markup.match(/ordinary-value/g)).toHaveLength(1);
  });

  test("keeps the complete raw value available when debugging is expanded", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolResultContent, {
        expanded: true,
        hasRawResult: true,
        rawResult,
        result: toolResult,
        useExecCodeModeFormatting: true,
      }),
    );

    expect(markup).toContain("$ui");
    expect(markup).toContain("total");
  });
});
