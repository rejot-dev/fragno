import WebSocket from "ws";

import { CODEMODE_LIMITS } from "../codemode-limits";
import { createCodemodeBridgeWebSocketUrl } from "./codemode-bridge-url";
import { CodemodeInterruptedError } from "./codemode-errors";
import { CodemodePeer } from "./codemode-peer";
import {
  codemodeActivationSchema,
  codemodeHostOperationSchema,
  type CodemodeCompletion,
  type CodemodeRemoteExecutor,
} from "./codemode-protocol";

let activeNodeActivations = 0;
type ConnectionOutcome =
  | { type: "complete"; completion: CodemodeCompletion }
  | { type: "interrupted"; error: Error };

/** Opens a fresh authenticated socket per activation; never retries, reconnects, or loads guest code. */
export function createCodemodeNodeExecutor(config: {
  url: string;
  apiKey: string;
}): CodemodeRemoteExecutor {
  const url = createCodemodeBridgeWebSocketUrl(config.url, "/v1/codemode/execute");
  if (!config.apiKey.trim()) {
    throw new Error("Codemode bridge API key must not be empty.");
  }

  return async function executeRemoteCodemode(activation, host): Promise<CodemodeCompletion> {
    codemodeActivationSchema.parse(activation);
    if (activeNodeActivations >= CODEMODE_LIMITS.maxNodeActivations) {
      throw new Error("CODEMODE_NODE_ACTIVATION_LIMIT_EXCEEDED");
    }
    activeNodeActivations += 1;
    const executionId = crypto.randomUUID();
    const startedAt = Date.now();
    let metrics = { messages: 0, bytes: 0, callsSent: 0, callsReceived: 0 };
    let outcome: CodemodeCompletion["status"] | "interrupted" = "interrupted";
    let draining: ReturnType<typeof host.settle> | null = null;
    const drainHost = () => {
      if (draining === null) {
        draining = host.settle();
        // An unabortable tool retains its admission slot until it really settles. Repeated
        // disconnects must not accumulate unlimited host work after callers have timed out.
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
    try {
      const terminal = await new Promise<ConnectionOutcome>((resolve) => {
        let completion: CodemodeCompletion | null = null;
        const socket = new WebSocket(url.href, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          handshakeTimeout: CODEMODE_LIMITS.connectTimeoutMs,
          maxPayload: CODEMODE_LIMITS.maxFrameBytes,
          perMessageDeflate: false,
          followRedirects: false,
        });
        const deadline = setTimeout(
          () => {
            peer.close(new CodemodeInterruptedError("CODEMODE_ACTIVATION_TIMED_OUT"));
          },
          CODEMODE_LIMITS.connectTimeoutMs +
            (activation.kind === "workflow"
              ? activation.timeoutMs
              : CODEMODE_LIMITS.activationTimeoutMs),
        );
        const peer = new CodemodePeer({
          role: "node",
          send(text) {
            socket.send(text);
          },
          bufferedBytes: () => socket.bufferedAmount,
          close() {
            socket.terminate();
          },
          handle: (call) =>
            host.handle(codemodeHostOperationSchema.parse(call), (callback) => peer.call(callback)),
          control(message) {
            if (message.type !== "complete" || completion !== null) {
              throw new Error("CODEMODE_UNEXPECTED_CONTROL_MESSAGE");
            }
            completion = message.completion;
            peer.close();
          },
          onClose(error) {
            clearTimeout(deadline);
            metrics = peer.metrics;
            host.close();
            resolve(
              completion === null
                ? { type: "interrupted", error }
                : { type: "complete", completion },
            );
          },
        });
        socket.on("open", () => {
          try {
            peer.send({ type: "start", protocolVersion: 1, executionId, activation });
          } catch (error) {
            peer.close(error instanceof Error ? error : new Error(String(error)));
          }
        });
        socket.on("message", (data, binary) => {
          peer.receive(binary ? data : data.toString());
        });
        socket.on("error", (error) => {
          peer.close(new CodemodeInterruptedError(`CODEMODE_CONNECTION_FAILED: ${error.message}`));
        });
        socket.on("close", () => {
          peer.close();
        });
        socket.on("unexpected-response", (_request, response) => {
          response.resume();
          peer.close(
            new CodemodeInterruptedError(`CODEMODE_UPGRADE_FAILED: HTTP ${response.statusCode}`),
          );
        });
      });
      // Rejecting a guest callback can make Node schedule a step retry after the socket is gone.
      // Preserve that host outcome rather than replacing it with a generic network error.
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
      host.close();
      void drainHost();
      console.info("codemode.activation", {
        executionId,
        peer: "node",
        kind: activation.kind,
        workflowInstanceId: activation.kind === "workflow" ? activation.event.instanceId : null,
        durationMs: Date.now() - startedAt,
        outcome,
        ...metrics,
      });
    }
  };
}
