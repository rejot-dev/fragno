// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from "vitest";

import { MemoryRouter } from "react-router";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionHeader } from "./session-header";

afterEach(cleanup);

test("clears the draft before navigating to a new session", () => {
  const onStartNewSession = vi.fn();

  render(
    <MemoryRouter initialEntries={["/sessions/workflow/session-1"]}>
      <SessionHeader
        newSessionHref="/sessions"
        onStartNewSession={onStartNewSession}
        session={{ id: "session-1", name: "Current session" }}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole("link", { name: "New session" }));

  expect(onStartNewSession).toHaveBeenCalledOnce();
});
