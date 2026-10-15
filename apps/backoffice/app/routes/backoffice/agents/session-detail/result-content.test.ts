import { describe, expect, test } from "vitest";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import { ToolResultContent } from "./tool-result-content";

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

function renderToolResult({
  expanded = false,
  rawValue = rawResult,
  result = toolResult,
  useExecCodeModeFormatting = true,
}: {
  expanded?: boolean;
  rawValue?: unknown;
  result?: typeof toolResult;
  useExecCodeModeFormatting?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(ToolResultContent, {
      expanded,
      hasRawResult: true,
      parsedResult: parseBackofficeUiResult(rawValue),
      rawResult: rawValue,
      result,
      useExecCodeModeFormatting,
    }),
  );
}

describe("ToolResultContent", () => {
  test("moves valid generated UI out of the tool card", () => {
    const markup = renderToolResult({});

    expect(markup).not.toContain("Generated interface ready");
    expect(markup).not.toContain("Open interface");
    expect(markup).toContain("Raw result");
    expect(markup).not.toContain('aria-label="Orders"');
    expect(markup).not.toContain(">24</p>");
    expect(markup).not.toContain("raw-sidecar-marker");
    expect(markup).not.toContain("log-sidecar-marker");
  });

  test("renders only the returned string when codemode logs are presented separately", () => {
    const ordinaryResult = {
      role: "toolResult",
      toolCallId: "tool-ordinary",
      toolName: "execCodeMode",
      content: [{ type: "text", text: "log-sidecar-marker\nordinary-value" }],
      details: { result: "ordinary-value", logs: ["log-sidecar-marker"] },
      isError: false,
      timestamp: 1,
    } as never;
    const markup = renderToolResult({ rawValue: "ordinary-value", result: ordinaryResult });

    expect(markup).not.toContain("log-sidecar-marker");
    expect(markup.match(/ordinary-value/g)).toHaveLength(1);
  });

  test("preserves ordinary JSON result formatting", () => {
    const markup = renderToolResult({ rawValue: { status: "ready", count: 3 } });

    expect(markup).toContain("&quot;status&quot;: &quot;ready&quot;");
    expect(markup).toContain("&quot;count&quot;: 3");
  });

  test("preserves expanded ordinary codemode results", () => {
    const markup = renderToolResult({ expanded: true, rawValue: { status: "ready" } });

    expect(markup).toContain("max-h-[70vh]");
    expect(markup).toContain("min-h-64");
    expect(markup).toContain("&quot;status&quot;: &quot;ready&quot;");
  });

  test("renders tagged invalid UI as a compact failed notice with raw disclosure", () => {
    const invalidResult = {
      total: 24,
      $ui: { ...rawResult.$ui, version: 2 },
    };
    const markup = renderToolResult({ rawValue: invalidResult });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Generated interface unavailable");
    expect(markup).toContain("Unsupported $ui version");
    expect(markup).toContain("Raw result");
  });

  test("preserves non-codemode text and image result blocks", () => {
    const nonCodemodeResult = {
      role: "toolResult",
      toolCallId: "tool-image",
      toolName: "read",
      content: [
        { type: "text", text: "read failed" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      details: {},
      isError: true,
      timestamp: 1,
    } as never;
    const markup = renderToolResult({
      rawValue: undefined,
      result: nonCodemodeResult,
      useExecCodeModeFormatting: false,
    });

    expect(markup).toContain("read failed");
    expect(markup).toContain('src="data:image/png;base64,aW1hZ2U="');
    expect(markup).toContain('alt="Message attachment"');
  });
});
