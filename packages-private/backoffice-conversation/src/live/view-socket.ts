import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
  PI_AGENT_WATCH_REFUSED,
  type PiAgentQueueEntry,
  type PiAgentWatchFrame,
  type PiAgentWatchMessage,
  type PiOlderSubagents,
  type PiSubagentSummary,
} from "@fragno-dev/backoffice-api/v0/pi";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import type { ConversationView } from "@earendil-works/pi-durable";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * What waits in the agent's queue, how many subagents wait for a slot, and whether stopping the
 * agent paused it.
 */
export type PiAgentQueueState = {
  paused: boolean;
  items: PiAgentQueueEntry[];
  waitingSubagents: number;
};

/**
 * The agent's subagents the socket sent, by request ID, as they last changed: those that wait or
 * run, and the newest of the others. `older` says which it left out, as of connecting.
 */
export type PiAgentSubagentsState = {
  older: PiOlderSubagents | null;
  byRequestId: ReadonlyMap<string, PiSubagentSummary>;
};

/** A subagent's conversation, once its socket sent it, or why it will not. */
export type PiSubagentConversationState =
  | { status: "connecting" }
  | { status: "ready"; view: ConversationView }
  | { status: "failed"; message: string };

/**
 * The agent's live conversation, its queue and subagents, and the conversations of the subagents
 * followed, as far as its view socket has delivered them.
 */
type PiAgentViewState =
  | { status: "connecting" }
  | {
      status: "ready";
      view: ConversationView;
      queue: PiAgentQueueState;
      subagents: PiAgentSubagentsState;
      conversations: ReadonlyMap<string, PiSubagentConversationState>;
    }
  | { status: "failed"; message: string };

/** The agent's view socket: what it delivered, and how to follow its subagents' conversations. */
export type PiAgentViewSocket = PiAgentViewState & {
  /**
   * Follows the conversation of the subagent `requestId` asked for, once it started, until every
   * returned function was called; the socket follows it again after reconnecting.
   */
  follow: (requestId: string) => () => void;
};

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

/** The subagents a page follows on one agent's socket, which outlive each connection. */
class Followers {
  readonly #counts = new Map<string, number>();
  #send: ((message: PiAgentWatchMessage) => void) | null = null;

  follows(subagent: string) {
    return this.#counts.has(subagent);
  }

  /** Sends what the connection's socket follows from now on; null while none is open. */
  connect(send: ((message: PiAgentWatchMessage) => void) | null) {
    this.#send = send;
    for (const subagent of this.#counts.keys()) {
      send?.({ type: "subscribe", subagent });
    }
  }

  follow(subagent: string, unfollowed: () => void): () => void {
    const count = this.#counts.get(subagent) ?? 0;
    this.#counts.set(subagent, count + 1);
    if (count === 0) {
      this.#send?.({ type: "subscribe", subagent });
    }
    let followed = true;
    return () => {
      if (!followed) {
        return;
      }
      followed = false;
      const remaining = (this.#counts.get(subagent) ?? 1) - 1;
      if (remaining > 0) {
        this.#counts.set(subagent, remaining);
        return;
      }
      this.#counts.delete(subagent);
      this.#send?.({ type: "unsubscribe", subagent });
      unfollowed();
    };
  }
}

/**
 * The agent's live conversation from its view socket, which reconnects until the agent refuses
 * it, including when asking for its URL fails. Its first view is the whole conversation, so the
 * page needs no server-loaded copy.
 */
export function usePiAgentViewSocket(source: PiAgentViewSocketSource): PiAgentViewSocket {
  const { key } = source;
  // The state is the socket's whose key it carries: another agent's view is never this one's.
  const [keyed, setKeyed] = useState<{ key: string; state: PiAgentViewState }>({
    key,
    state: { status: "connecting" },
  });
  const socketUrl = useEffectEvent(source.url);
  // Each agent's socket follows its own subagents.
  const followers = useMemo(() => new Followers(), [key]);

  useEffect(() => {
    function setState(update: (current: PiAgentViewState) => PiAgentViewState) {
      setKeyed((current) => ({
        key,
        state: update(current.key === key ? current.state : { status: "connecting" }),
      }));
    }
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
      // Each connection sends the queue and the agent's whole view before any of its ops, which
      // apply to the view, then its subagents; each followed subagent's view comes before its ops.
      let queue: PiAgentQueueState = { paused: false, items: [], waitingSubagents: 0 };
      let view: ConversationView | undefined;
      let subagents: PiAgentSubagentsState | undefined;
      let conversations = new Map<string, PiSubagentConversationState>();
      function show() {
        if (view === undefined || subagents === undefined) {
          return;
        }
        if ([...conversations.keys()].some((subagent) => !followers.follows(subagent))) {
          conversations = new Map(
            [...conversations].filter(([subagent]) => followers.follows(subagent)),
          );
        }
        const ready = { status: "ready" as const, view, queue, subagents, conversations };
        setState(() => ready);
      }
      connection.addEventListener("open", () => {
        followers.connect((message) => {
          if (connection.readyState === WebSocket.OPEN) {
            connection.send(JSON.stringify(message));
          }
        });
      });
      connection.addEventListener("message", (event: MessageEvent<string>) => {
        // The agent object is the socket's only sender.
        const frame = JSON.parse(event.data) as PiAgentWatchFrame<ConversationView, Op>;
        switch (frame.type) {
          case "queue":
            queue = {
              paused: frame.paused,
              items: frame.items,
              waitingSubagents: frame.waitingSubagents,
            };
            break;
          case "subagents":
            subagents = {
              older: frame.older,
              byRequestId: new Map(
                frame.subagents.map((subagent) => [subagent.requestId, subagent]),
              ),
            };
            break;
          case "subagent":
            // Changes come after the subagents sent on connecting.
            if (subagents !== undefined) {
              subagents = {
                older: subagents.older,
                byRequestId: new Map(subagents.byRequestId).set(
                  frame.subagent.requestId,
                  frame.subagent,
                ),
              };
            }
            break;
          case "unsubscribed":
            conversations = new Map(conversations).set(frame.subagent, {
              status: "failed",
              message: frame.message,
            });
            break;
          case "view":
          case "ops": {
            if (frame.subagent === null) {
              if (frame.type === "view") {
                reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
                view = frame.view;
              } else {
                // The rendered view is React state, which must not be mutated.
                view = applyImmutable<ConversationView>(view, frame.ops);
              }
              break;
            }
            // A subagent unfollowed meanwhile may still send what was on its way.
            if (!followers.follows(frame.subagent)) {
              return;
            }
            const current = conversations.get(frame.subagent);
            const next =
              frame.type === "view"
                ? frame.view
                : applyImmutable<ConversationView>(
                    current?.status === "ready" ? current.view : undefined,
                    frame.ops,
                  );
            conversations = new Map(conversations).set(frame.subagent, {
              status: "ready",
              view: next,
            });
            break;
          }
        }
        show();
      });
      connection.addEventListener("close", (event) => {
        followers.connect(null);
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
      followers.connect(null);
      socket?.close();
    };
  }, [key, followers]);

  const follow = useCallback(
    (requestId: string) =>
      followers.follow(requestId, () => {
        // An unfollowed conversation stops changing, so it is shown no longer.
        setKeyed((current) => {
          if (current.key !== key || current.state.status !== "ready") {
            return current;
          }
          const conversations = new Map(current.state.conversations);
          conversations.delete(requestId);
          return { key, state: { ...current.state, conversations } };
        });
      }),
    [followers, key],
  );
  const state = keyed.key === key ? keyed.state : { status: "connecting" as const };
  return { ...state, follow };
}
