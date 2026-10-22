import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  codemodeActivationSchema,
  codemodeBridgeAnswerSchema,
  type CodemodeExecutionCapability,
  type CodemodeExecutor,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError } from "../execution/codemode-errors";
import type { CodemodeActivationServices } from "../execution/execute-codemode-activation";
import {
  bridgeAnswerTerminal,
  settleCodemodeActivation,
  type CodemodeActivationTerminal,
} from "./codemode-activation-settlement";
import {
  codemodeActivationWallTimeMs,
  createCodemodeBridgeExecution,
} from "./codemode-bridge-execution";

/** A service binding to the bridge's `CodemodeExecutor` entrypoint serves the execution contract. */
export function codemodeExecutionService(binding: Fetcher): CodemodeExecutionCapability {
  return binding as Fetcher & CodemodeExecutionCapability;
}

/**
 * Runs each activation as one call to an execution service, passing the caller's capabilities as
 * RPC stubs. The service enforces the activation deadline; this one only outlasts a lost service.
 */
export function createCodemodeServiceExecutor(
  service: CodemodeExecutionCapability,
): CodemodeExecutor {
  return async function executeCodemodeThroughService(activation, host) {
    codemodeActivationSchema.parse(activation);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // The service answers every activation, so only a lost service rejects; a malformed answer is
    // a contract failure rather than an interruption.
    const received = await Promise.race([
      service.execute(
        { protocolVersion: 2, executionId: crypto.randomUUID(), activation },
        host.capabilities,
      ),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => {
            reject(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
          },
          CODEMODE_LIMITS.connectTimeoutMs + codemodeActivationWallTimeMs(activation),
        );
      }),
    ])
      .then(
        (value) => ({ received: true as const, value }),
        (error: unknown) => ({ received: false as const, error }),
      )
      .finally(() => {
        clearTimeout(deadline);
      });
    const terminal: CodemodeActivationTerminal = received.received
      ? bridgeAnswerTerminal(codemodeBridgeAnswerSchema.parse(received.value))
      : {
          type: "interrupted",
          cause: received.error instanceof Error ? received.error.message : String(received.error),
        };
    return await settleCodemodeActivation(host, terminal);
  };
}

/**
 * Serves the bridge's execution in this process, for tests that supply their own Worker Loader.
 * A missing compiler fails source activations; precompiled modules still run.
 */
export function createCodemodeInProcessExecutor(
  services: CodemodeActivationServices,
): CodemodeExecutor {
  return createCodemodeServiceExecutor(
    createCodemodeBridgeExecution(services, {
      waitUntil(promise) {
        void promise.catch(() => {});
      },
    }),
  );
}
