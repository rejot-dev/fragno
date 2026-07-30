// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";

import { cleanup, render, screen } from "@testing-library/react";

import { BackofficeUiErrorBoundary } from "./renderer";

function ThrowingComponent(): never {
  throw new Error("component render failed");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BackofficeUiErrorBoundary", () => {
  test("contains component exceptions and renders the local fallback", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      createElement(
        BackofficeUiErrorBoundary,
        { fallback: createElement("p", null, "Generated interface unavailable") },
        createElement(ThrowingComponent),
      ),
    );

    expect(screen.getByText("Generated interface unavailable")).toBeDefined();
    expect(consoleError).toHaveBeenCalled();
  });
});
