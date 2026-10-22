// @vitest-environment happy-dom

import { afterEach, describe, expect, test, assert } from "vitest";

import { parseBackofficeUiResult } from "@fragno-private/backoffice-ui/result";
import { createElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ResultContent } from "./result-content";
import { ToolResultContent } from "./tool-result-content";

afterEach(cleanup);

describe("tool results", () => {
  test("keeps a valid generated result out of the tool card", () => {
    const value = {
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

    render(
      createElement(ToolResultContent, {
        expanded: false,
        hasRawResult: true,
        parsedResult: parseBackofficeUiResult(value),
        rawResult: value,
        result: {
          role: "toolResult",
          toolCallId: "generated",
          toolName: "execCodeMode",
          content: [],
          details: { result: value },
          isError: false,
          timestamp: 1,
        } as never,
        useExecCodeModeFormatting: true,
      }),
    );

    expect(screen.queryByLabelText("Orders")).toBeNull();
    expect(screen.getByText("Raw result")).toBeDefined();
  });

  test("formats and mounts raw output only while its disclosure is open", async () => {
    const value = {
      debugPayload: "raw-only-marker",
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

    const { container } = render(
      createElement(
        ResultContent,
        {
          parsedValue: parseBackofficeUiResult(value),
          showRawValue: false,
          value,
        },
        createElement("p", null, "Ordinary result"),
      ),
    );

    expect(screen.getByLabelText("Orders")).toBeDefined();
    const rawSummary = screen.getByText("Raw result").closest("summary");
    const rawDetails = rawSummary?.closest("details");
    assert(rawDetails);
    assert(!rawDetails.open);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("raw-only-marker");

    if (!rawSummary) {
      throw new Error("Expected raw result disclosure summary.");
    }
    fireEvent.click(rawSummary);

    await waitFor(() => {
      assert(rawDetails.open);
      expect(container.querySelector("pre")).not.toBeNull();
      expect(container.textContent).toContain("raw-only-marker");
    });

    fireEvent.click(rawSummary);

    await waitFor(() => {
      assert(!rawDetails.open);
      expect(container.querySelector("pre")).toBeNull();
      expect(container.textContent).not.toContain("raw-only-marker");
    });
  });
});
