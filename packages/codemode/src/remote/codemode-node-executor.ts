import { RpcSession } from "capnweb";
import WebSocket from "ws";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  CODEMODE_EXECUTION_HTTP_PATH,
  codemodeActivationSchema,
  codemodeCompletionSchema,
  type CodemodeCompletion,
  type CodemodeExecutionCapability,
  type CodemodeRemoteExecutor,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError } from "../execution/codemode-errors";
import { createCloudflareBridgeWebSocketUrl } from "../transport/cloudflare-bridge-url";
import { assertCodemodeRpcPayloadSize } from "../transport/codemode-rpc-payload";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";

let activeNodeActivations = 0;

/** Opens one authenticated Cap'n Web session per activation; never retries or loads guest code. */
export function createCodemodeNodeExecutor(config: {
  url: string;
  apiKey: string;
}): CodemodeRemoteExecutor {
  const url = createCloudflareBridgeWebSocketUrl(config.url, CODEMODE_EXECUTION_HTTP_PATH);
  if (!config.apiKey.trim()) {
    throw new Error("Codemode bridge API key must not be empty.");
  }
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  // Reject invalid header values before reserving activation capacity or opening a socket.
  new Headers(headers);
  return async function executeRemoteCodemode(activation, host): Promise<CodemodeCompletion> {
    if (activeNodeActivations >= CODEMODE_LIMITS.maxNodeActivations) {
      throw new Error("CODEMODE_NODE_ACTIVATION_LIMIT_EXCEEDED");
    }
    activeNodeActivations += 1;
    try {
      codemodeActivationSchema.parse(activation);
      if (activation.kind === "compiled") {
        assertCodemodeRpcPayloadSize(activation);
      }
    } catch (error) {
      activeNodeActivations -= 1;
      throw error;
    }
    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    let outcome: CodemodeCompletion["status"] | "interrupted" = "interrupted";
    let draining: ReturnType<typeof host.settle> | null = null;
    const drainHost = () => {
      if (draining === null) {
        draining = host.settle();
        // Detached, unabortable tools retain their admission slot until they actually settle.
        void draining.then(
          () => {
            activeNodeActivations -= 1;
          },
          () => {
            activeNodeActivations -= 1;
          },
        );
      }
      return draining;
    };
    const socket = new WebSocket(url.href, {
      headers,
      handshakeTimeout: CODEMODE_LIMITS.connectTimeoutMs,
      maxPayload: CODEMODE_LIMITS.maxFrameBytes,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let session: RpcSession<CodemodeExecutionCapability> | null = null;
    const transport = new CodemodeWebSocketTransport(
      socket,
      () => socket.bufferedAmount,
      () => {
        host.close();
      },
      () => {
        if (!session) {
          return 0;
        }
        const { imports, exports } = session.getStats();
        return imports + exports;
      },
    );
    const deadline = setTimeout(
      () => {
        transport.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
      },
      CODEMODE_LIMITS.connectTimeoutMs +
        (activation.kind === "workflow" || activation.kind === "compiled"
          ? activation.timeoutMs
          : CODEMODE_LIMITS.activationTimeoutMs),
    );
    try {
      let terminal:
        | { type: "complete"; completion: CodemodeCompletion }
        | { type: "interrupted"; error: Error };
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", (error) => {
            reject(new CodemodeInterruptedError(`CODEMODE_CONNECTION_FAILED: ${error.message}`));
          });
          socket.once("close", () => {
            reject(new CodemodeInterruptedError("CODEMODE_EXECUTION_INTERRUPTED"));
          });
          socket.once("unexpected-response", (_request, response) => {
            response.resume();
            const error = new CodemodeInterruptedError(
              `CODEMODE_UPGRADE_FAILED: HTTP ${response.statusCode}`,
            );
            reject(error);
            socket.terminate();
          });
        });
        session = new RpcSession<CodemodeExecutionCapability>(
          transport,
          undefined,
          CODEMODE_RPC_OPTIONS,
        );
        const bridge = session.getRemoteMain();
        try {
          const completion = codemodeCompletionSchema.parse(
            await bridge.execute(
              { protocolVersion: 2, executionId, activation },
              host.capabilities,
            ),
          );
          terminal = { type: "complete", completion };
        } finally {
          // Close normally before disposing the main stub, whose disposer otherwise aborts transport.
          transport.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_ENDED"));
          bridge[Symbol.dispose]();
        }
      } catch (error) {
        terminal = {
          type: "interrupted",
          error: new CodemodeInterruptedError(
            `CODEMODE_EXECUTION_INTERRUPTED: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
      host.close();
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let suspension;
      try {
        suspension = await Promise.race([
          drainHost(),
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
        outcome = "suspended";
        return {
          status: "suspended",
          reason: suspension,
          logs: terminal.type === "complete" ? terminal.completion.logs : [],
        };
      }
      if (terminal.type === "interrupted") {
        throw terminal.error;
      }
      if (terminal.completion.status === "suspended") {
        throw new Error("CODEMODE_UNISSUED_SUSPENSION");
      }
      outcome = terminal.completion.status;
      return terminal.completion;
    } finally {
      clearTimeout(deadline);
      transport.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_ENDED"));
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      host.close();
      void drainHost();
      console.info("codemode.activation", {
        executionId,
        peer: "node",
        kind: activation.kind,
        workflowInstanceId: activation.kind === "workflow" ? activation.event.instanceId : null,
        durationMs: Date.now() - startedAt,
        outcome,
        ...transport.metrics,
      });
    }
  };
}
