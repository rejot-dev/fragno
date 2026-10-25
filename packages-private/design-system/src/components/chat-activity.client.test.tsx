// @vitest-environment happy-dom

import { afterEach, assert, test } from "vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ChatActivity, ChatActivityStep, type ChatActivityStatus } from "./chat-activity";

afterEach(cleanup);

const running: ChatActivityStatus = {
  kind: "running",
  headline: "Finding the unpaid invoices",
  startedAt: new Date(),
};
const settled: ChatActivityStatus = {
  kind: "settled",
  outcome: "done",
  durationMs: 4_200,
  note: "1 tool",
  failedSteps: 0,
};

function renderTurn(status: ChatActivityStatus) {
  return (
    <ChatActivity status={status} artifacts={null}>
      <ChatActivityStep
        icon="code"
        state="done"
        title="codemode"
        detail={null}
        durationMs={1_200}
        outlined={false}
        actions={null}
      >
        <p>Result body</p>
      </ChatActivityStep>
    </ChatActivity>
  );
}

function isOpen(name: RegExp) {
  return screen.getByRole("button", { name }).getAttribute("aria-expanded") === "true";
}

test("a turn's card stays open while it runs and folds when it settles", () => {
  const turn = render(renderTurn(running));
  assert.isTrue(isOpen(/Finding the unpaid invoices/));
  assert.isNotNull(screen.queryByText("codemode"));

  turn.rerender(renderTurn(settled));
  assert.isFalse(isOpen(/Worked for 4\.2s/));
});

test("a card the reader opened while the turn ran stays as they left it", () => {
  const turn = render(renderTurn(running));
  // The reader folds it, then opens it again.
  fireEvent.click(screen.getByRole("button", { name: /Finding the unpaid invoices/ }));
  fireEvent.click(screen.getByRole("button", { name: /Finding the unpaid invoices/ }));

  turn.rerender(renderTurn(settled));
  assert.isTrue(isOpen(/Worked for 4\.2s/));
});
