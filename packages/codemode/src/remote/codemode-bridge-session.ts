import { RpcSession, RpcTarget } from "capnweb";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  codemodeExecutionRequestSchema,
  type CodemodeActivation,
  type CodemodeCapabilities,
  type CodemodeCompletion,
  type CodemodeExecutionCapability,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError, encodeCodemodeError } from "../execution/codemode-errors";
import {
  executeCodemodeActivation,
  type CodemodeActivationServices,
} from "../execution/execute-codemode-activation";
import { restrictCodemodeProvider } from "../host/codemode-host-capabilities";
import { assertCodemodeRpcPayloadSize } from "../transport/codemode-rpc-payload";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";
import { reserveCodemodeBridgeActivation } from "./codemode-bridge-activation-admission";
import { createCodemodeBridgeHost } from "./codemode-bridge-host";

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
  let outcome: CodemodeCompletion["status"] | "interrupted" = "interrupted";
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
    ): Promise<CodemodeCompletion> {
      if (identity) {
        throw new Error("CODEMODE_INVALID_START");
      }
      abort.signal.throwIfAborted();
      const { executionId, activation } = codemodeExecutionRequestSchema.parse(input);
      identity = {
        executionId,
        kind: activation.kind,
        workflowInstanceId: activation.kind === "workflow" ? activation.event.instanceId : null,
      };
      clearTimeout(deadline);
      deadline = setTimeout(
        () => {
          transport.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
        },
        activation.kind === "workflow" || activation.kind === "compiled"
          ? activation.timeoutMs
          : CODEMODE_LIMITS.activationTimeoutMs,
      );
      // Narrow both providers and tools; host lifecycle methods and original dispatchers stay private.
      const targets: CodemodeCapabilities = {
        dispatchers: Object.fromEntries(
          (activation.kind === "module-build" ? [] : activation.providers).map(
            ({ name, tools }) => [
              name,
              restrictCodemodeProvider(capabilities.dispatchers[name], tools),
            ],
          ),
        ),
        stepTarget: activation.kind === "workflow" ? capabilities.stepTarget : null,
      };
      const task = (async (): Promise<CodemodeCompletion> => {
        try {
          const host = createCodemodeBridgeHost(targets);
          const releaseActivation = reserveCodemodeBridgeActivation();
          function revokeBridgeHost() {
            host.close();
          }
          abort.signal.addEventListener("abort", revokeBridgeHost, { once: true });
          try {
            abort.signal.throwIfAborted();
            const completion = await executeCodemodeActivation(
              activation,
              services,
              host.capabilities,
              abort.signal,
              (error) => {
                transport.abort(error);
              },
            );
            if (activation.kind === "module-build") {
              assertCodemodeRpcPayloadSize(completion);
            }
            return completion;
          } finally {
            abort.signal.removeEventListener("abort", revokeBridgeHost);
            host.close();
            // Completion can reach Node's bounded drain while this isolate retains its lease.
            ctx.waitUntil(host.settle().finally(releaseActivation));
          }
        } catch (error) {
          return { status: "failed", error: encodeCodemodeError(error), logs: [] };
        }
      })();
      // Guest execution and forwarded host calls retain admission until actual bridge-side settlement.
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
