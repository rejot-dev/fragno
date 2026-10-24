import { applyImmutable } from "@earendil-works/chord/delta";
import { PI_AGENT_WATCH_REFUSED, type PiAgentQueueEntry } from "@fragno-dev/backoffice-api/v0/pi";
import { useEffect, useState } from "react";

import type { ConversationView } from "@earendil-works/pi-durable";

import type { PiAgentViewFrame } from "@/fragno/pi/agent/pi-agent-contract";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

/** What waits in the agent's queue, and whether stopping the agent paused it. */
export type PiAgentQueueState = { paused: boolean; items: PiAgentQueueEntry[] };

/**
 * The selected agent's live conversation and the items waiting in its queue, as far as its view
 * socket has delivered them.
 */
type PiSessionViewState =
  | { status: "connecting" }
  | { status: "ready"; view: ConversationView; queue: PiAgentQueueState }
  | { status: "failed"; message: string };

/**
 * The agent's live conversation from its view socket, which reconnects until the agent refuses
 * it. Its first view is the whole conversation, so the page needs no server-loaded copy.
 */
export function usePiSessionViewSocket(socketPath: string): PiSessionViewState {
  const [state, setState] = useState<PiSessionViewState>({ status: "connecting" });
  useEffect(() => {
    const url = new URL(socketPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let stopped = false;

    function connect() {
      socket = new WebSocket(url);
      // Each connection sends the queue and the whole view before any ops, which apply to the view.
      let queue: PiAgentQueueState = { paused: false, items: [] };
      let view: ConversationView | undefined;
      socket.addEventListener("message", (event: MessageEvent<string>) => {
        // The agent object is the socket's only sender.
        const frame = JSON.parse(event.data) as PiAgentViewFrame;
        if (frame.type === "queue") {
          queue = { paused: frame.paused, items: frame.items };
          setState((current) => (current.status === "ready" ? { ...current, queue } : current));
          return;
        }
        if (frame.type === "view") {
          reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
          view = frame.view;
        } else {
          // The rendered view is React state, which must not be mutated.
          view = applyImmutable<ConversationView>(view, frame.ops);
        }
        setState({ status: "ready", view, queue });
      });
      socket.addEventListener("close", (event) => {
        if (stopped) {
          return;
        }
        if (event.code >= PI_AGENT_WATCH_REFUSED) {
          // A view that already arrived stays readable.
          setState((current) =>
            current.status === "ready" ? current : { status: "failed", message: event.reason },
          );
          return;
        }
        reconnectTimer = setTimeout(connect, reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      });
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      socket.close();
    };
  }, [socketPath]);
  return state;
}
