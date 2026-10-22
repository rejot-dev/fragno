import { RpcSession } from "capnweb";
import WebSocket from "ws";

import { CODEMODE_LIMITS } from "../codemode-limits";
import {
  CODEMODE_EXECUTION_HTTP_PATH,
  codemodeActivationSchema,
  codemodeBridgeAnswerSchema,
  type CodemodeCompletion,
  type CodemodeExecutionCapability,
  type CodemodeExecutor,
} from "../execution/codemode-activation-contract";
import { CodemodeInterruptedError } from "../execution/codemode-errors";
import { createCloudflareBridgeWebSocketUrl } from "../transport/cloudflare-bridge-url";
import { assertCodemodeRpcPayloadSize } from "../transport/codemode-rpc-payload";
import {
  CODEMODE_RPC_OPTIONS,
  CodemodeWebSocketTransport,
} from "../transport/codemode-websocket-transport";
import {
  bridgeAnswerTerminal,
  settleCodemodeActivation,
  type CodemodeActivationTerminal,
} from "./codemode-activation-settlement";
import { codemodeActivationWallTimeMs } from "./codemode-bridge-execution";

/** Opens one authenticated Cap'n Web session per activation; never retries or loads guest code. */
export function createCodemodeNodeExecutor(config: {
  url: string;
  apiKey: string;
}): CodemodeExecutor {
  const url = createCloudflareBridgeWebSocketUrl(config.url, CODEMODE_EXECUTION_HTTP_PATH);
  if (!config.apiKey.trim()) {
    throw new Error("Codemode bridge API key must not be empty.");
  }
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  // Reject invalid header values before opening a socket.
  new Headers(headers);
  return async function executeRemoteCodemode(activation, host) {
    codemodeActivationSchema.parse(activation);
    if (activation.kind === "compiled") {
      assertCodemodeRpcPayloadSize(activation);
    }
    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    let outcome: CodemodeCompletion["status"] | "interrupted" | "thrown" = "thrown";
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
        // Revoke as soon as the session drops; settlement awaits the same revocation.
        void host.close();
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
      CODEMODE_LIMITS.connectTimeoutMs + codemodeActivationWallTimeMs(activation),
    );
    async function receiveCompletion(): Promise<unknown> {
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
          const message = `CODEMODE_UPGRADE_FAILED: HTTP ${response.statusCode}`;
          const status = response.statusCode ?? 0;
          // A refused request, such as a wrong API key, fails the same way on every attempt.
          reject(
            status >= 400 && status < 500
              ? new Error(message)
              : new CodemodeInterruptedError(message),
          );
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
        return await bridge.execute(
          { protocolVersion: 2, executionId, activation },
          host.capabilities,
        );
      } finally {
        // Close normally before disposing the main stub, whose disposer otherwise aborts transport.
        transport.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_ENDED"));
        bridge[Symbol.dispose]();
      }
    }
    try {
      // The bridge answers every activation, so only a lost session interrupts it; a refused
      // connection or a malformed answer is a contract failure instead.
      const received = await receiveCompletion().then(
        (value) => ({ received: true as const, value }),
        (error: unknown) => {
          if (error instanceof CodemodeInterruptedError) {
            return { received: false as const, cause: error.message };
          }
          throw error;
        },
      );
      const terminal: CodemodeActivationTerminal = received.received
        ? bridgeAnswerTerminal(codemodeBridgeAnswerSchema.parse(received.value))
        : { type: "interrupted", cause: received.cause };
      const completion = await settleCodemodeActivation(host, terminal);
      outcome = completion.status;
      return completion;
    } finally {
      clearTimeout(deadline);
      transport.abort(new CodemodeInterruptedError("CODEMODE_ACTIVATION_ENDED"));
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      await host.close();
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
