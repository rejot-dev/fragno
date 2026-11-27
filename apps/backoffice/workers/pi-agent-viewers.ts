import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiSubagentSummary } from "@fragno-dev/backoffice-api/v0/pi";

import type {
  Conversation,
  ConversationId,
  ConversationView,
  WatchHandle,
} from "@earendil-works/pi-durable";

import type { PiAgentViewFrame, PiAgentWaitingQueue } from "@/fragno/pi/agent/pi-agent-contract";

/** A view socket, as either runtime's WebSocket offers it to the agent. */
export type PiAgentViewer = {
  /** Sends one JSON-encoded `PiAgentViewFrame`. */
  send(message: string): void;
  close(code: number, reason: string): void;
};

/** Closes a viewer as worth reconnecting after, which starts again from a whole view. */
const RECONNECT = 1012;

/**
 * A viewer's time connected, or following one subagent: what it holds, which it gives back once it
 * ends. It can end while it still starts, so what it takes on later is given back at once.
 */
export class PiAgentViewerConnection {
  #closed = false;
  readonly #releases = new Set<() => void>();

  get closed() {
    return this.#closed;
  }

  /** Gives `release` back when the connection ends; the returned function gives it back now. */
  hold(release: () => void): () => void {
    if (this.#closed) {
      release();
      return () => {};
    }
    this.#releases.add(release);
    return () => {
      if (this.#releases.delete(release)) {
        release();
      }
    };
  }

  close() {
    this.#closed = true;
    const releases = [...this.#releases];
    this.#releases.clear();
    for (const release of releases) {
      release();
    }
  }
}

/**
 * A conversation the viewers watch, through one watch, so each commit is encoded once. Its frames
 * name it as `subagent` does: null for the agent's own.
 */
type Watched = {
  subagent: string | null;
  watching: Promise<WatchHandle<ConversationView>>;
  viewers: Set<PiAgentViewer>;
  /** Viewers waiting for the watch to open, which keep it from stopping meanwhile. */
  joining: number;
};

/**
 * The agent's view sockets. Each follows the agent's conversation, and gets its queue and its
 * subagents, and follows the conversations of the subagents it subscribes to; each conversation
 * through a watch its viewers share, open while any watches it.
 */
export class PiAgentViewers {
  readonly #watched = new Map<ConversationId, Watched>();
  // The sockets following the agent's own conversation, which every socket does once it has its
  // view: they get its queue and subagents.
  readonly #agentViewers = new Set<PiAgentViewer>();
  // Sockets the object kept while it hibernated, which lost their view with its memory.
  readonly #hibernated = new Set<PiAgentViewer>();
  // Only the manager knows the queue; it publishes every change, and before each viewer connects.
  // Hibernation forgets it, so the first publication after waking is taken whatever its revision.
  #queue: PiAgentWaitingQueue | null = null;

  /** Sends the agent's viewers its queue, unless they had a later revision of it. */
  publishQueue(queue: PiAgentWaitingQueue) {
    if (this.#queue && this.#queue.revision >= queue.revision) {
      return;
    }
    this.#queue = queue;
    broadcast(queueFrame(queue), this.#agentViewers);
  }

  /** Whether any viewer follows the agent, which the agent's subagents are sent to. */
  get watched() {
    return this.#agentViewers.size > 0;
  }

  /** Sends the agent's viewers a subagent that started or ended. */
  publishSubagent(subagent: PiSubagentSummary) {
    broadcast({ type: "subagent", subagent }, this.#agentViewers);
  }

  /**
   * Closes the agent's viewers as worth reconnecting after, which sends them their subagents again,
   * as when a change of one could not be sent: no later change may follow it.
   */
  resynchronize() {
    for (const viewer of this.#agentViewers) {
      viewer.close(RECONNECT, "The agent's subagents changed.");
    }
  }

  /**
   * Sends the viewer the conversation's whole view, after the queue for the agent's own, then every
   * change, until the connection closes. `subagent` names a subagent's conversation, null the
   * agent's. Returns the view sent; null when the connection closed meanwhile, or the watch ended
   * as it opened, which closes the viewer. A watch that cannot open rejects, sending nothing.
   */
  async watch(
    viewer: PiAgentViewer,
    conversation: Conversation,
    subagent: string | null,
    connection: PiAgentViewerConnection,
  ): Promise<ConversationView | null> {
    const { id } = conversation;
    const watched = this.#watchedConversation(conversation, subagent);
    watched.joining += 1;
    let watch: WatchHandle<ConversationView>;
    try {
      watch = await watched.watching;
    } finally {
      watched.joining -= 1;
    }
    if (connection.closed) {
      this.#release(id, watched);
      return null;
    }
    // The watch ended while it opened, as when the agent's session closed.
    if (this.#watched.get(id) !== watched) {
      viewer.close(RECONNECT, "The conversation closed.");
      return null;
    }
    if (subagent === null && this.#queue) {
      viewer.send(JSON.stringify(queueFrame(this.#queue)));
    }
    // `value` is the latest view the watch delivered, and every delivery is broadcast at once, so
    // the first ops this viewer receives start from this view.
    const view = watch.value;
    viewer.send(JSON.stringify({ type: "view", subagent, view } satisfies PiAgentViewFrame));
    watched.viewers.add(viewer);
    if (subagent === null) {
      this.#agentViewers.add(viewer);
    }
    connection.hold(() => {
      watched.viewers.delete(viewer);
      if (subagent === null) {
        this.#agentViewers.delete(viewer);
      }
      this.#release(id, watched);
    });
    return view;
  }

  // Concurrent viewers share the opening watch; one that failed or ended is opened again.
  #watchedConversation(conversation: Conversation, subagent: string | null): Watched {
    const { id } = conversation;
    const existing = this.#watched.get(id);
    if (existing) {
      return existing;
    }
    const viewers = new Set<PiAgentViewer>();
    const watching = (async () => {
      const watch = await conversation.watch(BACKGROUND_CONTEXT);
      // Each frame's ops turn the previous frame's view into this one's, so viewers that start
      // from any delivered view stay exact.
      watch.start(async (call) => {
        if (call.kind === "value") {
          broadcast({ type: "ops", subagent, ops: call.ops }, viewers);
        }
      });
      // A watch stops once no one watches; otherwise it ends with the agent's session, as when the
      // object closes, and its viewers reconnect.
      void watch.closed.then(() => {
        if (this.#watched.get(id) === watched) {
          this.#watched.delete(id);
        }
        for (const viewer of viewers) {
          viewer.close(RECONNECT, "The conversation closed.");
        }
        viewers.clear();
      });
      return watch;
    })();
    const watched: Watched = { subagent, watching, viewers, joining: 0 };
    this.#watched.set(id, watched);
    watching.catch(() => {
      if (this.#watched.get(id) === watched) {
        this.#watched.delete(id);
      }
    });
    return watched;
  }

  #release(id: ConversationId, watched: Watched) {
    if (watched.viewers.size > 0 || watched.joining > 0 || this.#watched.get(id) !== watched) {
      return;
    }
    this.#watched.delete(id);
    void watched.watching.then(
      async (watch) => await watch.stop(),
      () => {},
    );
  }

  /** Takes back a socket the object kept while it hibernated, until `closeHibernated`. */
  restore(viewer: PiAgentViewer): () => void {
    this.#hibernated.add(viewer);
    return () => {
      this.#hibernated.delete(viewer);
    };
  }

  /**
   * Closes the sockets kept while the object hibernated, as worth reconnecting after. Their view
   * went with the object's memory, and reopening the agent may commit what they never saw, so they
   * start again from a whole view; reconnecting also authorizes them again.
   */
  closeHibernated() {
    const viewers = [...this.#hibernated];
    this.#hibernated.clear();
    for (const viewer of viewers) {
      viewer.close(RECONNECT, "The agent restarted.");
    }
  }
}

function queueFrame({ paused, items, waitingSubagents }: PiAgentWaitingQueue): PiAgentViewFrame {
  return { type: "queue", paused, items, waitingSubagents };
}

function broadcast(frame: PiAgentViewFrame, viewers: Iterable<PiAgentViewer>) {
  let message: string | null = null;
  for (const viewer of viewers) {
    message ??= JSON.stringify(frame);
    viewer.send(message);
  }
}
