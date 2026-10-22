import { RpcSession, RpcTarget } from "capnweb";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  codemodeExecutionRequestSchema,
  type CodemodeActivation,
  type CodemodeCapabilities,
  type CodemodeBridgeAnswer,
  type CodemodeExecutionCapability,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError, encodeCodemodeError } from "../execution/codemode-errors";
import type { CodemodeActivationServices } from "../execution/execute-codemode-activation";
import { assertCodemodeRpcPayloadSize } from "../transport/codemode-rpc-payload";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";
import {
  codemodeActivationWallTimeMs,
  runCodemodeBridgeActivation,
} from "./codemode-bridge-execution";

function invalidCodemodeRequest(error: unknown): CodemodeBridgeAnswer {
  return { status: "failed", error: encodeCodemodeError(error), logs: [] };
}

/** Accepts one authenticated Cap'n Web session; activation execution owns compilation and guest loading. */
export function acceptCodemodeBridgeSession(
  socket: WebSocket,
  services: CodemodeActivationServices,
  ctx: Pick<ExecutionContext, "waitUntil">,
): void {
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout>;
  let sentBytes = 0;
  const startedAt = Date.now();
  let identity: {
    executionId: string;
    kind: CodemodeActivation["kind"];
    workflowInstanceId: string | null;
  } | null = null;
  let outcome: CodemodeBridgeAnswer["status"] | "interrupted" = "interrupted";
  let session: RpcSession | null = null;
  const transport = new CodemodeWebSocketTransport(
    {
      addEventListener: socket.addEventListener.bind(socket),
      send(text) {
        socket.send(text);
        sentBytes += new TextEncoder().encode(text).byteLength;
      },
      close: socket.close.bind(socket),
    },
    () => sentBytes,
    (error) => {
      clearTimeout(deadline);
      abort.abort(error);
      if (identity) {
        console.info("codemode.activation", {
          ...identity,
          peer: "bridge",
          durationMs: Date.now() - startedAt,
          outcome,
          ...transport.metrics,
        });
      }
    },
    () => {
      if (!session) {
        return 0;
      }
      const { imports, exports } = session.getStats();
      return imports + exports;
    },
  );
  class CodemodeExecutionTarget extends RpcTarget implements CodemodeExecutionCapability {
    async execute(
      input: Parameters<CodemodeExecutionCapability["execute"]>[0],
      capabilities: CodemodeCapabilities,
    ): Promise<CodemodeBridgeAnswer> {
      // The bridge answers every call; Node reads a rejection as a lost session and retries it.
      if (identity) {
        return invalidCodemodeRequest(new Error("CODEMODE_INVALID_START"));
      }
      abort.signal.throwIfAborted();
      const request = codemodeExecutionRequestSchema.safeParse(input);
      if (!request.success) {
        return invalidCodemodeRequest(request.error);
      }
      const { executionId, activation } = request.data;
      identity = {
        executionId,
        kind: activation.kind,
        workflowInstanceId: activation.kind === "workflow" ? activation.event.instanceId : null,
      };
      clearTimeout(deadline);
      // Activation deadlines end the guest, not the session, so Node receives a definitive
      // completion; only a lost session reaches Node as an interruption.
      const interruption = new AbortController();
      function interruptOnSessionEnd() {
        interruption.abort(abort.signal.reason);
      }
      abort.signal.addEventListener("abort", interruptOnSessionEnd, { once: true });
      deadline = setTimeout(() => {
        interruption.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
      }, codemodeActivationWallTimeMs(activation));
      const task = (async (): Promise<CodemodeBridgeAnswer> => {
        const completion = await runCodemodeBridgeActivation(
          activation,
          capabilities,
          services,
          ctx,
          interruption.signal,
          (error) => {
            interruption.abort(error);
          },
        );
        abort.signal.removeEventListener("abort", interruptOnSessionEnd);
        if (activation.kind !== "module-build") {
          return completion;
        }
        try {
          assertCodemodeRpcPayloadSize(completion);
          return completion;
        } catch (error) {
          return { status: "failed", error: encodeCodemodeError(error), logs: [] };
        }
      })();
      ctx.waitUntil(task.then(() => {}));
      const completion = await task;
      abort.signal.throwIfAborted();
      outcome = completion.status;
      // Node closes after receiving the RPC result, not before Cap'n Web has sent its resolution.
      return completion;
    }
  }
  session = new RpcSession(transport, new CodemodeExecutionTarget(), CODEMODE_RPC_OPTIONS);
  deadline = setTimeout(() => {
    transport.abort(new CodemodeInterruptedError("CODEMODE_START_TIMED_OUT"));
  }, CODEMODE_LIMITS.startTimeoutMs);
  socket.accept();
}
