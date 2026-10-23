import { piAgentWatchFrameSchema, type PiAgentQueueEntry } from "@fragno-dev/backoffice-api/v0/pi";
import { useCallback, useSyncExternalStore } from "react";
import { z } from "zod";

import type { ConversationView } from "@earendil-works/pi-durable";

import type { PiAgentViewStreamFrame } from "@/fragno/pi/agent/pi-agent-contract";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
// The server sends the view right after the headers, so a connection without one by then has
// stalled; it would otherwise never fail and leave the conversation loading forever.
const FIRST_VIEW_TIMEOUT_MS = 5_000;

function parsePiSessionViewStreamLine(line: string): PiAgentViewStreamFrame {
  const parsed = piAgentWatchFrameSchema.parse(JSON.parse(line));
  // The manager deliberately transports the agent-owned structural view as opaque JSON.
  return parsed.type === "queue"
    ? parsed
    : { type: parsed.type, view: parsed.view as ConversationView };
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

/**
 * The selected agent's live conversation and the items waiting in its queue, as far as its view
 * stream has delivered them.
 */
type PiSessionViewStreamState =
  | { status: "connecting" }
  | { status: "ready"; view: ConversationView; queue: PiAgentQueueState }
  | { status: "failed"; message: string };

/** What waits in the agent's queue, and whether stopping the agent paused it. */
export type PiAgentQueueState = { paused: boolean; items: PiAgentQueueEntry[] };

async function readPiSessionViewStreamFailure(response: Response) {
  const body = z.object({ message: z.string() }).safeParse(await response.json().catch(() => null));
  return body.success
    ? body.data.message
    : `The conversation is unavailable (status ${response.status}).`;
}

const CONNECTING: PiSessionViewStreamState = { status: "connecting" };

/** One connection per stream, shared by everything showing that agent. */
type SharedPiSessionViewStream = {
  state: PiSessionViewStreamState;
  listeners: Set<() => void>;
  controller: AbortController;
};

// Browsers allow few connections per host over HTTP/1.1, and these streams never finish, so the
// agents page and the agent drawer showing the same agent share one.
const sharedPiSessionViewStreams = new Map<string, SharedPiSessionViewStream>();

function subscribeToSharedPiSessionView(streamUrl: string, listener: () => void) {
  let shared = sharedPiSessionViewStreams.get(streamUrl);
  if (!shared) {
    shared = { state: CONNECTING, listeners: new Set(), controller: new AbortController() };
    sharedPiSessionViewStreams.set(streamUrl, shared);
    void subscribeToPiSessionView(streamUrl, shared);
  }
  const subscribed = shared;
  subscribed.listeners.add(listener);
  return () => {
    subscribed.listeners.delete(listener);
    if (subscribed.listeners.size === 0) {
      subscribed.controller.abort();
      sharedPiSessionViewStreams.delete(streamUrl);
    }
  };
}

function setSharedPiSessionViewState(
  shared: SharedPiSessionViewStream,
  update: (current: PiSessionViewStreamState) => PiSessionViewStreamState,
) {
  const next = update(shared.state);
  if (next === shared.state) {
    return;
  }
  shared.state = next;
  for (const listener of shared.listeners) {
    listener();
  }
}

/** Maintains one reconnecting NDJSON subscription for a durable Pi session. */
async function subscribeToPiSessionView(streamUrl: string, shared: SharedPiSessionViewStream) {
  const { signal } = shared.controller;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  while (!signal.aborted) {
    const connection = new AbortController();
    // How far a stalled connection got, since browsers report every abort alike.
    let progress = "no response";
    const stalled = setTimeout(() => {
      connection.abort();
    }, FIRST_VIEW_TIMEOUT_MS);
    try {
      const response = await fetch(streamUrl, {
        headers: { accept: "application/x-ndjson" },
        signal: AbortSignal.any([signal, connection.signal]),
      });
      progress = `status ${response.status}, no frames`;
      if (!response.ok) {
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404 ||
          response.status === 409
        ) {
          const message = await readPiSessionViewStreamFailure(response);
          // A view that already arrived stays readable when a reconnect is refused.
          setSharedPiSessionViewState(shared, (current) =>
            current.status === "ready" ? current : { status: "failed", message },
          );
          return;
        }
        throw new Error(`Pi session view stream failed with status ${response.status}.`);
      }
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      // Each connection starts with the queue, which waits here for the first view.
      let queue: PiAgentQueueState = { paused: false, items: [] };
      await consumePiSessionViewNdjson(response, (frame) => {
        if (frame.type === "queue") {
          queue = { paused: frame.paused, items: frame.items };
          progress = `status ${response.status}, queue frame only`;
          setSharedPiSessionViewState(shared, (current) =>
            current.status === "ready" ? { ...current, queue } : current,
          );
          return;
        }
        clearTimeout(stalled);
        setSharedPiSessionViewState(shared, () => ({ status: "ready", view: frame.view, queue }));
      });
    } catch (cause) {
      if (signal.aborted) {
        return;
      }
      if (connection.signal.aborted) {
        console.error(
          `Pi session view stream sent no view within ${FIRST_VIEW_TIMEOUT_MS}ms (${progress}); reconnecting.`,
        );
      } else {
        console.error("Pi session view stream disconnected.", cause);
      }
    } finally {
      clearTimeout(stalled);
    }
    await waitForPiSessionViewReconnect(reconnectDelayMs, signal);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }
}

/**
 * The agent's live conversation from its view stream. Its first frame is the whole conversation
 * view, so the page needs no server-loaded copy.
 */
export function usePiSessionViewStream(streamUrl: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToSharedPiSessionView(streamUrl, listener),
    [streamUrl],
  );
  return useSyncExternalStore(
    subscribe,
    () => sharedPiSessionViewStreams.get(streamUrl)?.state ?? CONNECTING,
    () => CONNECTING,
  );
}
