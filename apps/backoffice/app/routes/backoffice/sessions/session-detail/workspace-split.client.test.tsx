// @vitest-environment happy-dom

import { afterEach, describe, expect, test, assert } from "vitest";

import { useEffect } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionWorkspaceSplit } from "./workspace-split";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("SessionWorkspaceSplit", () => {
  test("keeps the conversation mounted while the workspace opens and closes", () => {
    let mountCount = 0;
    let unmountCount = 0;

    function Conversation() {
      useEffect(() => {
        mountCount += 1;
        return () => {
          unmountCount += 1;
        };
      }, []);
      return <div>Conversation</div>;
    }

    const { container, rerender } = render(
      <SessionWorkspaceSplit storageKey="workspace-test" left={<Conversation />} right={null} />,
    );

    rerender(
      <SessionWorkspaceSplit
        storageKey="workspace-test"
        left={<Conversation />}
        right={<div>Workspace</div>}
      />,
    );
    const split = container.querySelector("[data-session-workspace-split]");
    assert(split);
    assert(split.classList.contains("h-full"));
    assert(split.classList.contains("overflow-hidden"));

    const threadPane = container.querySelector("[data-session-thread-pane]");
    assert(threadPane);
    assert(threadPane.classList.contains("flex"));
    assert(threadPane.classList.contains("flex-col"));
    assert(threadPane.classList.contains("bo-session-thread-pane"));
    const firstDrawer = container.querySelector(".bo-session-workspace-drawer");
    assert(firstDrawer);
    assert(firstDrawer.classList.contains("h-full"));
    assert(firstDrawer.classList.contains("overflow-hidden"));

    rerender(
      <SessionWorkspaceSplit storageKey="workspace-test" left={<Conversation />} right={null} />,
    );
    rerender(
      <SessionWorkspaceSplit
        storageKey="workspace-test"
        left={<Conversation />}
        right={<div>Workspace</div>}
      />,
    );

    const reopenedDrawer = container.querySelector(".bo-session-workspace-drawer");
    expect(reopenedDrawer).not.toBeNull();
    expect(reopenedDrawer).not.toBe(firstDrawer);
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);
    expect(screen.getByText("Conversation")).toBeDefined();
  });

  test("supports keyboard resizing and exposes the current split", () => {
    render(
      <SessionWorkspaceSplit
        storageKey="workspace-keyboard-test"
        left={<div>Conversation</div>}
        right={<div>Workspace</div>}
      />,
    );

    const separator = screen.getByRole("separator", { name: "Resize session workspace" });
    assert(separator.getAttribute("aria-valuenow") === "54");

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    assert(separator.getAttribute("aria-valuenow") === "52");

    fireEvent.keyDown(separator, { key: "End" });
    assert(separator.getAttribute("aria-valuenow") === "66");
  });
});
