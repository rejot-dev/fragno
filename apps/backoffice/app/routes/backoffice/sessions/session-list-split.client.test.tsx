// @vitest-environment happy-dom

import { afterEach, describe, test, assert } from "vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionListSplit } from "./session-list-split";

const bodyCursor = () => document.body.style.cursor;
const bodyUserSelect = () => document.body.style.userSelect;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function sessionListSplit(storageKey: string) {
  return (
    <SessionListSplit
      storageKey={storageKey}
      mobileNavigation={<nav>Mobile sessions</nav>}
      sidebar={<aside>Session list</aside>}
    >
      <div>Session contents</div>
    </SessionListSplit>
  );
}

function renderSplit(storageKey = "session-list-width") {
  return render(sessionListSplit(storageKey));
}

describe("SessionListSplit", () => {
  test("resizes the session list with the keyboard", () => {
    renderSplit();

    const separator = screen.getByRole("separator", { name: "Resize session list" });
    assert(separator.getAttribute("aria-valuenow") === "288");

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    assert(separator.getAttribute("aria-valuenow") === "304");

    fireEvent.keyDown(separator, { key: "Home" });
    assert(separator.getAttribute("aria-valuenow") === "224");

    fireEvent.doubleClick(separator);
    assert(separator.getAttribute("aria-valuenow") === "288");
  });

  test("resizes the session list by dragging the shared divider", () => {
    const { container } = renderSplit();
    const split = container.querySelector<HTMLElement>("[data-session-list-split]");
    assert(split);
    split.getBoundingClientRect = () =>
      ({ left: 100, width: 1_000, right: 1_100, top: 0, bottom: 600, height: 600 }) as DOMRect;

    const separator = screen.getByRole("separator", { name: "Resize session list" });
    fireEvent.pointerDown(separator, { clientX: 388 });
    fireEvent.pointerMove(window, { clientX: 460 });

    assert(separator.getAttribute("aria-valuenow") === "360");
    assert(split.style.getPropertyValue("--session-list-width") === "360px");

    fireEvent.pointerUp(window);
    assert(document.body.style.cursor === "");
    assert(document.body.style.userSelect === "");
  });

  test("clears drag state when pointer interaction is cancelled or focus is lost", () => {
    renderSplit();
    const separator = screen.getByRole("separator", { name: "Resize session list" });

    fireEvent.pointerDown(separator);
    assert(bodyCursor() === "col-resize");
    assert(bodyUserSelect() === "none");

    fireEvent.pointerCancel(window);
    assert(bodyCursor() === "");
    assert(bodyUserSelect() === "");

    fireEvent.pointerDown(separator);
    fireEvent.blur(window);
    assert(bodyCursor() === "");
    assert(bodyUserSelect() === "");
  });

  test("restores the stored session list width", () => {
    window.localStorage.setItem("stored-session-list-width", "352");
    renderSplit("stored-session-list-width");

    assert(
      screen
        .getByRole("separator", { name: "Resize session list" })
        .getAttribute("aria-valuenow") === "352",
    );
  });

  test("reloads the stored width when the storage key changes", () => {
    window.localStorage.setItem("session-list-width:org-a", "320");
    window.localStorage.setItem("session-list-width:org-b", "368");
    const { rerender } = renderSplit("session-list-width:org-a");

    assert(
      screen
        .getByRole("separator", { name: "Resize session list" })
        .getAttribute("aria-valuenow") === "320",
    );

    rerender(sessionListSplit("session-list-width:org-b"));

    assert(
      screen
        .getByRole("separator", { name: "Resize session list" })
        .getAttribute("aria-valuenow") === "368",
    );
    assert(window.localStorage.getItem("session-list-width:org-b") === "368");
  });
});
