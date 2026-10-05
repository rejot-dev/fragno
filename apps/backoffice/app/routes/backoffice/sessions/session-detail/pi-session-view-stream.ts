import { useEffect, useState } from "react";

import type { ConversationView } from "@earendil-works/pi-durable";

import {
  piAgentViewStreamFrameSchema,
  type PiAgentViewStreamFrame,
} from "@/fragno/pi-manager/pi-agent-contract";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

function parsePiSessionViewStreamLine(line: string): PiAgentViewStreamFrame {
  const parsed = piAgentViewStreamFrameSchema.parse(JSON.parse(line));
  // The manager deliberately transports the agent-owned structural view as opaque JSON.
  return { type: parsed.type, view: parsed.view as ConversationView };
}

/** Reads complete NDJSON frames even when the transport splits JSON across byte chunks. */
export async function consumePiSessionViewNdjson(
  response: Response,
  onFrame: (frame: PiAgentViewStreamFrame) => void,
) {
  if (!response.body) {
    throw new Error("Pi session view stream response has no body.");
  }

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          onFrame(parsePiSessionViewStreamLine(line));
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) {
        const finalLine = buffer.trim();
        if (finalLine) {
          onFrame(parsePiSessionViewStreamLine(finalLine));
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function waitForPiSessionViewReconnect(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Maintains one reconnecting NDJSON subscription for the selected durable Pi session. */
export function usePiSessionViewStream({
  initialView,
  streamUrl,
}: {
  initialView: ConversationView;
  streamUrl: string;
}) {
  const [view, setView] = useState(initialView);

  useEffect(() => {
    const controller = new AbortController();

    async function subscribeToPiSessionView() {
      let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(streamUrl, {
            headers: { accept: "application/x-ndjson" },
            signal: controller.signal,
          });
          if (!response.ok) {
            if (
              response.status === 401 ||
              response.status === 403 ||
              response.status === 404 ||
              response.status === 409
            ) {
              return;
            }
            throw new Error(`Pi session view stream failed with status ${response.status}.`);
          }
          reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
          await consumePiSessionViewNdjson(response, (frame) => {
            setView(frame.view);
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            return;
          }
          console.error("Pi session view stream disconnected.", cause);
        }
        await waitForPiSessionViewReconnect(reconnectDelayMs, controller.signal);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      }
    }

    void subscribeToPiSessionView();
    return () => {
      controller.abort();
    };
  }, [streamUrl]);

  return view;
}
