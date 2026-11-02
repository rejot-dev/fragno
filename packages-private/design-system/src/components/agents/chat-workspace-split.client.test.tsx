// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi, assert } from "vitest";

import { useEffect } from "react";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ChatWorkspaceSplit } from "./chat-workspace-split";

const bodyCursor = () => document.body.style.cursor;
const bodyUserSelect = () => document.body.style.userSelect;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ChatWorkspaceSplit", () => {
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
      <ChatWorkspaceSplit
        storageKey="workspace-test"
        conversation={<Conversation />}
        workspace={null}
      />,
    );

    rerender(
      <ChatWorkspaceSplit
        storageKey="workspace-test"
        conversation={<Conversation />}
        workspace={<div>Workspace</div>}
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
      <ChatWorkspaceSplit
        storageKey="workspace-test"
        conversation={<Conversation />}
        workspace={null}
      />,
    );
    rerender(
      <ChatWorkspaceSplit
        storageKey="workspace-test"
        conversation={<Conversation />}
        workspace={<div>Workspace</div>}
      />,
    );

    const reopenedDrawer = container.querySelector(".bo-session-workspace-drawer");
    expect(reopenedDrawer).not.toBeNull();
    expect(reopenedDrawer).not.toBe(firstDrawer);
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);
    expect(screen.getByText("Conversation")).toBeDefined();
  });

  test("continues without persisted sizing when local storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    expect(() =>
      render(
        <ChatWorkspaceSplit
          storageKey="workspace-storage-test"
          conversation={<div>Conversation</div>}
          workspace={<div>Workspace</div>}
        />,
      ),
    ).not.toThrow();
  });

  test("clears drag state when pointer interaction is cancelled or focus is lost", () => {
    render(
      <ChatWorkspaceSplit
        storageKey="workspace-drag-test"
        conversation={<div>Conversation</div>}
        workspace={<div>Workspace</div>}
      />,
    );
    const separator = screen.getByRole("separator", { name: "Resize session workspace" });

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

  test("supports keyboard resizing and exposes the current split", () => {
    render(
      <ChatWorkspaceSplit
        storageKey="workspace-keyboard-test"
        conversation={<div>Conversation</div>}
        workspace={<div>Workspace</div>}
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
