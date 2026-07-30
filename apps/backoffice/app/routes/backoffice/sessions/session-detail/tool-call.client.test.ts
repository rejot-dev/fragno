// @vitest-environment happy-dom

import { afterEach, describe, expect, test, assert, vi } from "vitest";

import { createElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import { ResultContent } from "./result-content";
import { ToolCallDetails, ToolResultContent } from "./tool-call";

afterEach(cleanup);

describe("ToolCallDetails", () => {
  test("keeps ordinary tool cards closed by default", () => {
    const { container } = render(
      createElement(
        ToolCallDetails,
        { autoOpen: false, className: "tool-card", resetKey: "ordinary" },
        createElement("summary", null, "Ordinary result"),
        createElement("p", null, "Result body"),
      ),
    );

    const details = container.querySelector("details");
    assert(details);
    assert(!details.open);
  });

  test("automatically opens when a completed result becomes tagged generated UI", async () => {
    const { container, rerender } = render(
      createElement(
        ToolCallDetails,
        { autoOpen: false, className: "tool-card", resetKey: "generated" },
        createElement("summary", null, "Generated result"),
        createElement("p", null, "Result body"),
      ),
    );

    rerender(
      createElement(
        ToolCallDetails,
        { autoOpen: true, className: "tool-card", resetKey: "generated" },
        createElement("summary", null, "Generated result"),
        createElement("p", null, "Result body"),
      ),
    );

    await waitFor(() => {
      assert(container.querySelector("details")?.open);
    });
  });

  test("opens a valid generated result through its workspace launcher", () => {
    const onOpenGeneratedUi = vi.fn();
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
        onOpenGeneratedUi,
      }),
    );

    expect(screen.queryByLabelText("Orders")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open interface" }));
    expect(onOpenGeneratedUi).toHaveBeenCalledOnce();
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
      createElement(ResultContent, {
        children: createElement("p", null, "Ordinary result"),
        parsedValue: parseBackofficeUiResult(value),
        showRawValue: false,
        value,
      }),
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
