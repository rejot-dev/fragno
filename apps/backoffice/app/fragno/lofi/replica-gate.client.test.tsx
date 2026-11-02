// @vitest-environment happy-dom

import { afterEach, expect, test } from "vitest";

import type { LofiSqliteReplicaStatus } from "@fragno-dev/lofi/sqlite";

import { act, cleanup, render, screen } from "@testing-library/react";

import { LofiReplicaGate } from "./replica-gate";

afterEach(() => {
  cleanup();
});

/** A replica whose status the test sets, as the replica worker reports it. */
function replicaWithStatus(initial: LofiSqliteReplicaStatus) {
  let status = initial;
  const listeners = new Set<() => void>();
  return {
    getStatus: () => status,
    subscribeStatus(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report(next: LofiSqliteReplicaStatus) {
      status = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

test("keeps the view while synchronization fails after catching up, and says it may be stale", () => {
  const replica = replicaWithStatus({ phase: "catching-up", fraction: 0.5, error: null });
  render(
    <LofiReplicaGate replica={replica} title="Downloading…">
      <p>Connections</p>
    </LofiReplicaGate>,
  );
  expect(screen.queryByText("Connections")).toBeNull();
  expect(screen.getByText("Getting things ready… 50%")).not.toBeNull();

  act(() => replica.report({ phase: "caught-up", error: null }));
  expect(screen.getByText("Connections")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  const error = "Outbox stream read failed: nothing arrived for 15 s";
  act(() => replica.report({ phase: "caught-up", error }));
  expect(screen.getByText("Connections")).not.toBeNull();
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("Live updates interrupted");
  expect(notice.textContent).toContain(error);

  act(() => replica.report({ phase: "caught-up", error: null }));
  expect(screen.getByText("Connections")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
