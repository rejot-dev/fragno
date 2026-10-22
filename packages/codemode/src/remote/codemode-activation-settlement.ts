import { CODEMODE_LIMITS } from "../codemode-limits";
import type {
  CodemodeBridgeAnswer,
  CodemodeCompletion,
  CodemodeHost,
  CodemodeInterruption,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError } from "../execution/codemode-errors";

/** How a guest's execution ended, as its caller observed it, before the caller's host has drained. */
export type CodemodeActivationTerminal =
  | { type: "complete"; completion: CodemodeCompletion }
  | { type: "interrupted"; cause: string };

/** A bridge that declined the activation never ran it, so the caller treats it as interrupted. */
export function bridgeAnswerTerminal(answer: CodemodeBridgeAnswer): CodemodeActivationTerminal {
  return answer.status === "unavailable"
    ? { type: "interrupted", cause: answer.cause }
    : { type: "complete", completion: answer };
}

/**
 * Revokes the caller's host and waits, bounded, for its forwarded calls. The host's suspension
 * outranks the guest's report: a lost or caught RPC response must not lose a retry or wake, and a
 * suspension the host never issued is forged.
 */
export async function settleCodemodeActivation(
  host: CodemodeHost,
  terminal: CodemodeActivationTerminal,
): Promise<CodemodeCompletion | CodemodeInterruption> {
  // A completion reported before revocation holds would let the guest's tools outlive it.
  await host.close();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let suspension;
  try {
    suspension = await Promise.race([
      host.settle(),
      new Promise<never>((_resolve, reject) => {
        drainTimer = setTimeout(() => {
          reject(new CodemodeInterruptedError("CODEMODE_HOST_DRAIN_TIMED_OUT"));
        }, CODEMODE_LIMITS.hostDrainTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(drainTimer);
  }
  if (suspension !== null) {
    return {
      status: "suspended",
      reason: suspension,
      logs: terminal.type === "complete" ? terminal.completion.logs : [],
    };
  }
  if (terminal.type === "interrupted") {
    return { status: "interrupted", cause: terminal.cause };
  }
  if (terminal.completion.status === "suspended") {
    throw new Error("CODEMODE_UNISSUED_SUSPENSION");
  }
  return terminal.completion;
}
