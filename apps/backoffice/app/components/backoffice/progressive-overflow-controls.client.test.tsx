// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { useState } from "react";

import { act, cleanup, fireEvent, render } from "@testing-library/react";

import { ProgressiveOverflowControls } from "./progressive-overflow-controls";

const rectWithWidth = (width: number) =>
  ({ left: 0, width, right: width, top: 0, bottom: 40, height: 40 }) as DOMRect;

const elementDisplay = (element: HTMLElement) => element.style.display;
const elementText = (element: HTMLElement) => element.textContent;

function OverflowBoundaryHarness() {
  const [boundaryElement, setBoundaryElement] = useState<HTMLDivElement | null>(null);

  return (
    <div ref={setBoundaryElement} data-progressive-overflow-boundary>
      <ProgressiveOverflowControls
        measurementBoundary={boundaryElement}
        reservedWidth={100}
        groups={[
          { id: "detail", collapsePriority: 0, content: <div>Simple / Verbose</div> },
          { id: "view", collapsePriority: 1, content: <div>Code / Graph / Both</div> },
        ]}
        renderOverflow={(hiddenGroupIds) => (
          <button type="button">{[...hiddenGroupIds].join(",") || "none"}</button>
        )}
      />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProgressiveOverflowControls", () => {
  test("moves lower-priority groups into overflow before higher-priority groups", () => {
    let boundaryWidth = 500;
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-progressive-overflow-boundary")) {
          return rectWithWidth(boundaryWidth);
        }
        if (this.hasAttribute("data-progressive-overflow-controls")) {
          return rectWithWidth(200);
        }
        if (this.getAttribute("data-progressive-overflow-group") === "detail") {
          return rectWithWidth(120);
        }
        if (this.getAttribute("data-progressive-overflow-group") === "view") {
          return rectWithWidth(220);
        }
        if (this.hasAttribute("data-progressive-overflow-trigger")) {
          return rectWithWidth(40);
        }
        return rectWithWidth(0);
      },
    );

    const { container } = render(<OverflowBoundaryHarness />);

    const controls = container.querySelector<HTMLElement>("[data-progressive-overflow-controls]");
    const detail = container.querySelector<HTMLElement>(
      '[data-progressive-overflow-group="detail"]',
    );
    const view = container.querySelector<HTMLElement>('[data-progressive-overflow-group="view"]');
    const overflow = container.querySelector<HTMLElement>("[data-progressive-overflow-trigger]");
    assert(controls && detail && view && overflow);

    assert(elementDisplay(detail) === "");
    assert(elementDisplay(view) === "");
    assert(overflow.getAttribute("aria-hidden") === "true");

    act(() => {
      boundaryWidth = 360;
      fireEvent(window, new Event("resize"));
    });
    assert(elementDisplay(detail) === "none");
    assert(elementDisplay(view) === "");
    expect(overflow.getAttribute("aria-hidden")).toBeNull();
    assert(elementText(overflow) === "detail");

    act(() => {
      boundaryWidth = 300;
      fireEvent(window, new Event("resize"));
    });
    assert(elementDisplay(detail) === "none");
    assert(elementDisplay(view) === "none");
    assert(elementText(overflow) === "detail,view");

    act(() => {
      boundaryWidth = 500;
      fireEvent(window, new Event("resize"));
    });
    assert(elementDisplay(detail) === "");
    assert(elementDisplay(view) === "");
    assert(overflow.getAttribute("aria-hidden") === "true");
  });
});
