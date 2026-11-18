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

/** An activation the bridge declined or broke off has no outcome, so the caller treats it as interrupted. */
export function bridgeAnswerTerminal(answer: CodemodeBridgeAnswer): CodemodeActivationTerminal {
  return answer.status === "unavailable" || answer.status === "interrupted"
    ? { type: "interrupted", cause: answer.cause }
    : { type: "complete", completion: answer };
}

/**
 * Revokes the caller's host and waits, bounded, for its forwarded calls, so none outlives the
 * activation. A workflow guest ends its tick only once its step calls are done, so the wait matters
 * only for a guest that broke off.
 */
export async function settleCodemodeActivation(
  host: CodemodeHost,
  terminal: CodemodeActivationTerminal,
): Promise<CodemodeCompletion | CodemodeInterruption> {
  // A completion reported before revocation holds would let the guest's tools outlive it.
  await host.close();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
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
  return terminal.type === "interrupted"
    ? { status: "interrupted", cause: terminal.cause }
    : terminal.completion;
}
