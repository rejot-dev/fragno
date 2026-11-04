import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
  PI_AGENT_WATCH_REFUSED,
  type PiAgentQueueEntry,
  type PiAgentWatchFrame,
} from "@fragno-dev/backoffice-api/v0/pi";
import { useEffect, useEffectEvent, useState } from "react";

import type { ConversationView } from "@earendil-works/pi-durable";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

/** What waits in the agent's queue, and whether stopping the agent paused it. */
export type PiAgentQueueState = { paused: boolean; items: PiAgentQueueEntry[] };

/**
 * The agent's live conversation and the items waiting in its queue, as far as its view socket has
 * delivered them.
 */
type PiAgentViewState =
  | { status: "connecting" }
  | { status: "ready"; view: ConversationView; queue: PiAgentQueueState }
  | { status: "failed"; message: string };

/** Where an agent's view socket is, for each connection to it. */
export type PiAgentViewSocketSource = {
  /** Names the agent; another key connects to another socket. */
  key: string;
  /**
   * The socket's path or URL, asked for again for each connection, as a ticket opens only one. A
   * page's own origin and HTTP URLs connect over the matching WebSocket protocol.
   */
  url: () => string | Promise<string>;
};

/**
 * The agent's live conversation from its view socket, which reconnects until the agent refuses
 * it, including when asking for its URL fails. Its first view is the whole conversation, so the
 * page needs no server-loaded copy.
 */
export function usePiAgentViewSocket(source: PiAgentViewSocketSource): PiAgentViewState {
  const [state, setState] = useState<PiAgentViewState>({ status: "connecting" });
  const socketUrl = useEffectEvent(source.url);
  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    let stopped = false;

    function reconnect() {
      reconnectTimer = setTimeout(() => void connect(), reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }

    async function connect() {
      let address: URL;
      try {
        address = new URL(await socketUrl(), window.location.href);
      } catch {
        if (!stopped) {
          reconnect();
        }
        return;
      }
      if (stopped) {
        return;
      }
      if (address.protocol === "https:" || address.protocol === "http:") {
        address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      }
      const connection = new WebSocket(address);
      socket = connection;
      // Each connection sends the queue and the whole view before any ops, which apply to the view.
      let queue: PiAgentQueueState = { paused: false, items: [] };
      let view: ConversationView | undefined;
      connection.addEventListener("message", (event: MessageEvent<string>) => {
        // The agent object is the socket's only sender.
        const frame = JSON.parse(event.data) as PiAgentWatchFrame<ConversationView, Op>;
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
      connection.addEventListener("close", (event) => {
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
        reconnect();
      });
    }

    void connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [source.key]);
  return state;
}
