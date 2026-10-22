import { CODEMODE_LIMITS } from "../codemode-limits";
import { CodemodeCompilerBusyError } from "../compiler/codemode-compiler-admission";
import {
  codemodeExecutionRequestSchema,
  type CodemodeActivation,
  type CodemodeCapabilities,
  type CodemodeBridgeAnswer,
  type CodemodeExecutionCapability,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError, encodeCodemodeError } from "../execution/codemode-errors";
import {
  executeCodemodeActivation,
  type CodemodeActivationServices,
} from "../execution/execute-codemode-activation";
import { restrictCodemodeProvider } from "../host/codemode-host-capabilities";
import { createCodemodeBridgeHost } from "./codemode-bridge-host";

/** How long the bridge lets one activation run, compilation included. */
export function codemodeActivationWallTimeMs(activation: CodemodeActivation): number {
  return activation.kind === "workflow" || activation.kind === "compiled"
    ? activation.timeoutMs
    : CODEMODE_LIMITS.activationTimeoutMs;
}

/**
 * Runs one activation with the bridge's compiler and Worker Loader against the caller's
 * capabilities. Execution failures become failed completions; the caller decides suspensions.
 */
export async function runCodemodeBridgeActivation(
  activation: CodemodeActivation,
  capabilities: CodemodeCapabilities,
  services: CodemodeActivationServices,
  ctx: Pick<ExecutionContext, "waitUntil">,
  signal: AbortSignal,
  interrupt: (error: Error) => void,
): Promise<CodemodeBridgeAnswer> {
  // Narrow both providers and tools; host lifecycle methods and original dispatchers stay private.
  const targets: CodemodeCapabilities = {
    dispatchers: Object.fromEntries(
      (activation.kind === "module-build" ? [] : activation.providers).map(({ name, tools }) => [
        name,
        restrictCodemodeProvider(capabilities.dispatchers[name], tools),
      ]),
    ),
    stepTarget: activation.kind === "workflow" ? capabilities.stepTarget : null,
  };
  try {
    const host = createCodemodeBridgeHost(targets);
    function revokeBridgeHost() {
      void host.close();
    }
    signal.addEventListener("abort", revokeBridgeHost, { once: true });
    let rejectInterrupted: (error: unknown) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupted = reject;
    });
    function rejectOnAbort() {
      rejectInterrupted(signal.reason);
    }
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    try {
      signal.throwIfAborted();
      const execution = executeCodemodeActivation(
        activation,
        services,
        host.capabilities,
        signal,
        interrupt,
      );
      // A Worker Loader that cannot cancel its guest must not hold the activation past its
      // deadline. The abandoned execution still holds compiler admission, which workerd would
      // never release if the request ended without waiting for it.
      ctx.waitUntil(execution.then(ignoreSettlement, ignoreSettlement));
      return await Promise.race([execution, interrupted]);
    } finally {
      signal.removeEventListener("abort", rejectOnAbort);
      signal.removeEventListener("abort", revokeBridgeHost);
      await host.close();
      // Forwarded calls can still be settling after the guest returns; keep this request alive.
      ctx.waitUntil(host.settle());
    }
  } catch (error) {
    // Declined rather than failed: the activation never ran, so the caller may try it again.
    if (error instanceof CodemodeCompilerBusyError) {
      return { status: "unavailable", cause: error.message };
    }
    return { status: "failed", error: encodeCodemodeError(error), logs: [] };
  }
}

function ignoreSettlement() {}

/** One request per activation, each with its own deadline; a Worker entrypoint or tests serve it. */
export function createCodemodeBridgeExecution(
  services: CodemodeActivationServices,
  ctx: Pick<ExecutionContext, "waitUntil">,
): CodemodeExecutionCapability {
  return {
    async execute(input, capabilities) {
      // The service answers every call; its caller reads a rejection as a lost service.
      const request = codemodeExecutionRequestSchema.safeParse(input);
      if (!request.success) {
        return { status: "failed", error: encodeCodemodeError(request.error), logs: [] };
      }
      const { executionId, activation } = request.data;
      const startedAt = Date.now();
      const interruption = new AbortController();
      const interrupt = (error: Error) => {
        interruption.abort(error);
      };
      const deadline = setTimeout(() => {
        interrupt(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
      }, codemodeActivationWallTimeMs(activation));
      let outcome: CodemodeBridgeAnswer["status"] = "failed";
      try {
        const completion = await runCodemodeBridgeActivation(
          activation,
          capabilities,
          services,
          ctx,
          interruption.signal,
          interrupt,
        );
        outcome = completion.status;
        return completion;
      } finally {
        clearTimeout(deadline);
        console.info("codemode.activation", {
          executionId,
          peer: "bridge-service",
          kind: activation.kind,
          workflowInstanceId: activation.kind === "workflow" ? activation.event.instanceId : null,
          durationMs: Date.now() - startedAt,
          outcome,
        });
      }
    },
  };
}
