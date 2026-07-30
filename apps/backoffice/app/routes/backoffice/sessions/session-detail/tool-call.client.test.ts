// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";

import { createElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { parseBackofficeUiResult } from "@/backoffice-ui/result";

import { ResultContent } from "./result-content";
import { ToolCallDetails } from "./tool-call";

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

    expect(container.querySelector("details")?.open).toBe(false);
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
      expect(container.querySelector("details")?.open).toBe(true);
    });
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
    expect(rawDetails?.open).toBe(false);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("raw-only-marker");

    if (!rawSummary) {
      throw new Error("Expected raw result disclosure summary.");
    }
    fireEvent.click(rawSummary);

    await waitFor(() => {
      expect(rawDetails?.open).toBe(true);
      expect(container.querySelector("pre")).not.toBeNull();
      expect(container.textContent).toContain("raw-only-marker");
    });

    fireEvent.click(rawSummary);

    await waitFor(() => {
      expect(rawDetails?.open).toBe(false);
      expect(container.querySelector("pre")).toBeNull();
      expect(container.textContent).not.toContain("raw-only-marker");
    });
  });
});
