import { useState } from "react";

import { Button } from "./button";

type StopState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "stopping" }
  | { kind: "failed"; error: string };

/** Stopping ends the run for good, so it asks once more in place. */
export function RunStopControl({ onStop }: { onStop: () => Promise<void> }) {
  const [state, setState] = useState<StopState>({ kind: "idle" });
  const stop = () => {
    setState({ kind: "stopping" });
    onStop().then(
      () => {
        setState({ kind: "idle" });
      },
      (cause: unknown) => {
        setState({
          kind: "failed",
          error: cause instanceof Error ? cause.message : "Could not stop the run.",
        });
      },
    );
  };

  switch (state.kind) {
    case "idle":
      return (
        <Button
          variant="ghost"
          onClick={() => {
            setState({ kind: "confirming" });
          }}
          className="min-h-8 px-2 text-xs text-[var(--bo-muted)]"
        >
          Stop
        </Button>
      );
    case "confirming":
    case "stopping":
      return (
        <span className="flex items-center gap-1">
          <Button
            variant="danger"
            disabled={state.kind === "stopping"}
            onClick={stop}
            className="min-h-8 px-2 text-xs"
          >
            {state.kind === "stopping" ? "Stopping…" : "Stop the run"}
          </Button>
          <Button
            variant="ghost"
            disabled={state.kind === "stopping"}
            onClick={() => {
              setState({ kind: "idle" });
            }}
            className="min-h-8 px-2 text-xs"
          >
            Keep
          </Button>
        </span>
      );
    case "failed":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span role="alert" className="truncate text-[10px] text-[var(--bo-failed)]">
            {state.error}
          </span>
          <Button variant="ghost" onClick={stop} className="min-h-8 px-2 text-xs">
            Retry
          </Button>
        </span>
      );
  }
  throw new Error("Unsupported stop state.", { cause: state satisfies never });
}
