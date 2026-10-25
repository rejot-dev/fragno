import type { CodemodeToolResult } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import { encodeCodemodeError } from "@fragno-dev/codemode/execution/codemode-errors";
import type {
  CodemodeToolCall,
  CodemodeToolCallObserver,
} from "@fragno-dev/codemode/host/codemode-host-capabilities";

import type { CodemodeRunToolCall, CodemodeToolCallSettlement } from "./codemode-fragment";

const TOOL_SUMMARY_MAX_LENGTH = 500;

function boundToolSummary(summary: string) {
  return summary.length > TOOL_SUMMARY_MAX_LENGTH
    ? `${summary.slice(0, TOOL_SUMMARY_MAX_LENGTH - 3)}...`
    : summary;
}

/** Bounds a tool's input or output to what a log or history row can hold. */
function summarizeToolValue(value: unknown) {
  try {
    const summary = JSON.stringify(value);
    if (typeof summary === "string") {
      return boundToolSummary(summary);
    }
  } catch {
    // Fall through to String(...) for unserializable values.
  }
  return boundToolSummary(String(value));
}

/** How a call ended, as its run's history keeps it. */
export type CodemodeToolCallOutcome = Omit<CodemodeToolCallSettlement, "settledAt">;

/**
 * Where a run's tool calls are kept: each when its guest makes it, and again when it settles.
 * `started` returns what `settled` needs to find the call again, such as its row's ID.
 */
export type CodemodeToolCallRecorder<TStarted> = {
  started(sequence: number, call: CodemodeToolCall, input: string): Promise<TStarted> | TStarted;
  settled(started: TStarted, outcome: CodemodeToolCallOutcome): Promise<void> | void;
};

/**
 * Records a run's tool calls as bounded summaries. A failed call's output is its error message, and
 * a call named in `redactedResults` (`provider.tool`) keeps no output, such as a credential.
 */
export function codemodeToolCallObserver<TStarted>(
  redactedResults: readonly string[],
  recorder: CodemodeToolCallRecorder<TStarted>,
): CodemodeToolCallObserver {
  const redacted = new Set(redactedResults);
  let calls = 0;
  return async function recordToolCall(call, input, invoke) {
    // Taken before any await, so parallel calls keep the order the guest made them in.
    const sequence = calls++;
    const started = await recorder.started(sequence, call, summarizeToolValue(input));
    let result: CodemodeToolResult;
    try {
      result = await invoke();
    } catch (error) {
      await recorder.settled(started, {
        status: "failed",
        output: boundToolSummary(encodeCodemodeError(error).message),
      });
      throw error;
    }
    await recorder.settled(
      started,
      result.status === "error"
        ? { status: "failed", output: boundToolSummary(result.error.message) }
        : {
            status: "succeeded",
            output: redacted.has(`${call.provider}.${call.tool}`)
              ? "[redacted]"
              : summarizeToolValue(result.value),
          },
    );
    return result;
  };
}

/** A run's calls as its caller saw them, oldest first, kept in memory while the caller waits. */
export type CodemodeToolCallLog = {
  readonly calls: readonly CodemodeRunToolCall[];
  readonly recorder: CodemodeToolCallRecorder<number>;
};

/** `onChange` sees every call as it starts and again as it settles. */
export function createCodemodeToolCallLog(
  onChange: ((calls: readonly CodemodeRunToolCall[]) => void) | null,
): CodemodeToolCallLog {
  const calls: CodemodeRunToolCall[] = [];
  return {
    calls,
    recorder: {
      started(sequence, call, input) {
        calls[sequence] = { ...call, input, calledAt: new Date().toISOString(), status: "running" };
        onChange?.(calls);
        return sequence;
      },
      settled(sequence, outcome) {
        const { scope, provider, tool, input, calledAt } = calls[sequence];
        calls[sequence] = {
          scope,
          provider,
          tool,
          input,
          calledAt,
          ...outcome,
          settledAt: new Date().toISOString(),
        };
        onChange?.(calls);
      },
    },
  };
}
