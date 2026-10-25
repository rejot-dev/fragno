import { resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";

import { registeredSchemaName } from "./layout";
import type {
  LofiSqlitePort,
  LofiSqliteRequest,
  LofiSqliteResponse,
  LofiSqliteTabMessage,
  LofiSqliteViewResponse,
} from "./protocol";
import { registrationsNamingReplica } from "./rebuild";
import {
  openLofiSqliteReplicaOn,
  type LofiSqliteReplica,
  type LofiSqliteReplicaOptions,
} from "./replica";
import type { LofiSqliteSyncDatabase } from "./sync-connection";
import { sqlViewEngine, type LofiSqliteViewEngine, type LofiSqliteViews } from "./views";

export type LofiSqliteHostOptions = {
  replica: LofiSqliteReplicaOptions;
  /** Engines of views beyond SQL, such as `@fragno-dev/lofi-zql`'s. */
  engines: LofiSqliteViewEngine[];
  /** Where the page's requests arrive and its views' data goes. */
  port: LofiSqlitePort;
  openDatabase(options: { databaseName: string }): Promise<LofiSqliteSyncDatabase>;
  /** How often the leader tells the other tabs it still runs. */
  heartbeatIntervalMs: number;
  /** How long a tab waits without hearing the leader before it takes the lead. */
  leaderTimeoutMs: number;
};

export type LofiSqliteHost = {
  /** The replica, once this tab first leads. Only the leader opens it. */
  readonly leading: Promise<LofiSqliteReplica>;
  /** Stops answering the page and, if this tab leads, closes the replica and hands over. */
  close(): Promise<void>;
};

type SubscribeRequest = Extract<LofiSqliteRequest, { type: "subscribe" }>;

/** How a tab's turn at the leader lock ended: `timed out` if the leader went silent. */
type Turn = "ended" | "failed" | "timed out";

/** The leader's side: one replica, and one instance of each engine for the views of every tab. */
type Leader = {
  replica: LofiSqliteReplica;
  handle(tab: string, request: LofiSqliteRequest): void;
  receive(message: LofiSqliteTabMessage): void;
  close(): Promise<void>;
};

/**
 * Serves the page on the other end of `port` the live views it asks for: SQL views, and views of
 * the kinds `engines` maintain. One tab at a time, elected with a Web Lock, opens the replica and
 * maintains every tab's views as outbox entries arrive. The other tabs relay their page's requests
 * to it over a BroadcastChannel and open no database. When the leader closes, the next tab opens
 * the replica and every tab sends its views again.
 *
 * The leader sends heartbeats. A tab that waits for the lock and hears nothing for
 * `leaderTimeoutMs` steals it, and the deposed leader closes its replica once it runs again. A frozen
 * leader keeps the database's OPFS access handles, so its successor opens the replica only when it
 * resumes or is discarded.
 */
export function serveLofiSqlite(options: LofiSqliteHostOptions): LofiSqliteHost {
  const engines = new Map(
    [sqlViewEngine, ...options.engines].map((engine) => [engine.kind, engine] as const),
  );
  if (engines.size !== options.engines.length + 1) {
    throw new Error("Two view engines maintain views of the same kind.");
  }
  const group = tabGroupName(options.replica);
  const tab = crypto.randomUUID();
  const lifetime = new AbortController();
  const channel = new BroadcastChannel(group);
  const ownChannel = new BroadcastChannel(tabChannelName(group, tab));
  const postToPage = (response: LofiSqliteResponse) => {
    options.port.postMessage(response);
  };
  const tell = (message: LofiSqliteTabMessage) => {
    channel.postMessage(message);
  };

  // The page's live views, which every new leader is sent.
  const views = new Map<number, SubscribeRequest>();
  let leader: Leader | null = null;

  options.port.onmessage = (event: MessageEvent<LofiSqliteRequest>) => {
    const request = event.data;
    if (request.type === "subscribe") {
      views.set(request.id, request);
    } else {
      views.delete(request.id);
    }
    if (leader) {
      leader.handle(tab, request);
    } else {
      tell({ ...request, tab });
    }
  };
  ownChannel.onmessage = (event: MessageEvent<LofiSqliteViewResponse>) => {
    postToPage(event.data);
  };
  // When the tab last heard the leader, or began waiting for the lock.
  let leaderHeardAt = Date.now();
  // Aborts the tab's wait for the leader lock, which it then steals.
  let waiting: AbortController | null = null;
  const watchdog = setInterval(() => {
    if (waiting && Date.now() - leaderHeardAt > options.leaderTimeoutMs) {
      waiting.abort();
    }
  }, options.heartbeatIntervalMs);

  channel.onmessage = (event: MessageEvent<LofiSqliteTabMessage>) => {
    const message = event.data;
    if (
      message.type !== "hello" &&
      message.type !== "subscribe" &&
      message.type !== "unsubscribe"
    ) {
      leaderHeardAt = Date.now();
    }
    if (leader) {
      leader.receive(message);
      return;
    }
    switch (message.type) {
      case "status":
      case "failed":
        postToPage(message);
        break;
      case "leader":
        for (const request of views.values()) {
          tell({ ...request, tab });
        }
        break;
      case "heartbeat":
      case "hello":
      case "subscribe":
      case "unsubscribe":
        // For the leader.
        break;
    }
  };

  let resolveLeading: (replica: LofiSqliteReplica) => void;
  const leading = new Promise<LofiSqliteReplica>((resolve) => {
    resolveLeading = resolve;
  });
  const serve = async () => {
    // The tab holds its lock while it lives, so a leader that waits for the lock learns when the tab
    // is gone. It holds it before asking for anything.
    await new Promise<void>((held, failed) => {
      navigator.locks
        .request(tabLockName(group, tab), { signal: lifetime.signal }, async () => {
          held();
          await whenAborted(lifetime.signal);
        })
        .catch(failed);
    });
    tell({ type: "hello" });
    let turn: Turn = "ended";
    while (!lifetime.signal.aborted && turn !== "failed") {
      leaderHeardAt = Date.now();
      turn = await takeTurn(turn === "timed out");
    }
  };

  /** Waits for the leader lock, or steals it, and leads while the tab holds it. */
  const takeTurn = async (steal: boolean): Promise<Turn> => {
    const wait = new AbortController();
    const deposed = new AbortController();
    const held: { term: Promise<Turn> | null } = { term: null };
    waiting = steal ? null : wait;
    try {
      await navigator.locks.request(
        leaderLockName(group),
        // A steal is granted at once, so it takes no signal.
        steal ? { steal: true } : { signal: AbortSignal.any([lifetime.signal, wait.signal]) },
        () => {
          waiting = null;
          held.term = lead(AbortSignal.any([lifetime.signal, deposed.signal]));
          return held.term;
        },
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
      // Another tab stole the lock, or this tab stopped waiting for it.
      deposed.abort();
    } finally {
      waiting = null;
    }
    if (held.term) {
      return await held.term;
    }
    return wait.signal.aborted && !lifetime.signal.aborted ? "timed out" : "ended";
  };

  const lead = async (term: AbortSignal): Promise<Turn> => {
    // Chrome can grant a request whose signal was already aborted.
    if (term.aborted) {
      return "ended";
    }
    // Beats from the moment the tab holds the lock, so a slow open does not look like a frozen tab.
    const beat = () => {
      if (!term.aborted) {
        tell({ type: "heartbeat" });
      }
    };
    beat();
    const heartbeat = setInterval(beat, options.heartbeatIntervalMs);
    try {
      let opened: Leader;
      try {
        opened = await openLeader(options, {
          engines,
          group,
          tab,
          postToPage,
          tell,
          signal: term,
        });
      } catch (error) {
        // Releases the lock and stops competing, so another tab tries.
        const message = errorMessage(error);
        postToPage({ type: "failed", message });
        tell({ type: "failed", message });
        return "failed";
      }
      if (!term.aborted) {
        leader = opened;
        resolveLeading(opened.replica);
        for (const request of views.values()) {
          opened.handle(tab, request);
        }
        tell({ type: "leader" });
        await whenAborted(term);
        leader = null;
        // The tab that took the lead may have announced it before this tab learned it lost the lock.
        if (!lifetime.signal.aborted) {
          for (const request of views.values()) {
            tell({ ...request, tab });
          }
        }
      }
      await opened.close();
      return "ended";
    } finally {
      clearInterval(heartbeat);
    }
  };
  const serving = serve().catch((error: unknown) => {
    if (!lifetime.signal.aborted) {
      options.replica.onError(error);
    }
  });

  return {
    leading,
    async close() {
      lifetime.abort();
      clearInterval(watchdog);
      options.port.onmessage = null;
      // A closing leader's replica can still report its status, which it tells the other tabs.
      await serving;
      channel.close();
      ownChannel.close();
    },
  };
}

async function openLeader(
  options: LofiSqliteHostOptions,
  context: {
    engines: ReadonlyMap<string, LofiSqliteViewEngine>;
    group: string;
    tab: string;
    postToPage: (response: LofiSqliteResponse) => void;
    tell: (message: LofiSqliteTabMessage) => void;
    signal: AbortSignal;
  },
): Promise<Leader> {
  const { replica, withViews } = await openReplicaViews(options, context.engines);
  /** By tab, the kind of each of the tab's views, by id. */
  const tabViews = new Map<string, Map<number, string>>([[context.tab, new Map()]]);
  const tabChannels = new Map<string, BroadcastChannel>();
  const respond = (tab: string, response: LofiSqliteViewResponse) => {
    if (tab === context.tab) {
      context.postToPage(response);
    } else {
      tabChannels.get(tab)?.postMessage(response);
    }
  };

  const dropTab = (tab: string) => {
    const kinds = tabViews.get(tab)!;
    tabViews.delete(tab);
    tabChannels.get(tab)?.close();
    tabChannels.delete(tab);
    withViews((views) => {
      for (const [id, kind] of kinds) {
        views.get(kind)?.destroy(viewKey(tab, id));
      }
    }).catch(options.replica.onError);
  };
  const watchTab = (tab: string) => {
    if (tabViews.has(tab)) {
      return;
    }
    tabViews.set(tab, new Map());
    tabChannels.set(tab, new BroadcastChannel(tabChannelName(context.group, tab)));
    // Granted once the tab is gone, since it holds the lock while it lives.
    navigator.locks
      .request(tabLockName(context.group, tab), { signal: context.signal }, () => {
        dropTab(tab);
      })
      .catch(() => {
        // The leader closed first.
      });
  };

  const handle = (tab: string, request: LofiSqliteRequest) => {
    watchTab(tab);
    const kinds = tabViews.get(tab)!;
    const key = viewKey(tab, request.id);
    if (request.type === "subscribe") {
      kinds.set(request.id, request.kind);
      withViews((views) => {
        const engine = views.get(request.kind);
        if (!engine) {
          throw new Error(`No view engine maintains views of kind "${request.kind}".`);
        }
        engine.materialize(key, request.query, (data) => {
          respond(tab, { type: "data", id: request.id, data });
        });
      }).catch((error: unknown) => {
        respond(tab, { type: "error", id: request.id, message: errorMessage(error) });
      });
    } else {
      const kind = kinds.get(request.id);
      kinds.delete(request.id);
      withViews((views) => {
        if (kind !== undefined) {
          views.get(kind)?.destroy(key);
        }
      }).catch(options.replica.onError);
    }
  };

  // Notifications that arrive while a refresh waits for the lock are covered by it, so the tables
  // they changed add up until it runs; null once one did not say which.
  let refreshQueued = false;
  let changed: Set<string> | null = new Set();
  const unsubscribe = replica.subscribe(({ tables }) => {
    if (tables === null) {
      changed = null;
    } else {
      for (const table of tables) {
        changed?.add(table);
      }
    }
    if (refreshQueued) {
      return;
    }
    refreshQueued = true;
    withViews((views) => {
      refreshQueued = false;
      const tables = changed;
      changed = new Set();
      for (const engine of views.values()) {
        engine.refresh(tables);
      }
    }).catch(options.replica.onError);
  });
  const reportStatus = () => {
    const status = replica.getStatus();
    context.postToPage({ type: "status", status });
    context.tell({ type: "status", status });
  };
  const unsubscribeStatus = replica.subscribeStatus(reportStatus);
  reportStatus();

  return {
    replica,
    handle,
    receive(message) {
      switch (message.type) {
        case "hello":
          context.tell({ type: "status", status: replica.getStatus() });
          break;
        case "subscribe":
        case "unsubscribe": {
          const { tab, ...request } = message;
          handle(tab, request);
          break;
        }
        case "leader":
        case "heartbeat":
        case "status":
        case "failed":
          // Only a leader sends these.
          break;
      }
    },
    async close() {
      unsubscribe();
      unsubscribeStatus();
      for (const tabChannel of tabChannels.values()) {
        tabChannel.close();
      }
      await replica.close();
    },
  };
}

async function openReplicaViews(
  options: LofiSqliteHostOptions,
  engines: ReadonlyMap<string, LofiSqliteViewEngine>,
) {
  let database: LofiSqliteSyncDatabase | undefined;
  const replica = await openLofiSqliteReplicaOn(options.replica, {
    openDatabase: async (open) => (database = await options.openDatabase(open)),
  });
  const { connection } = database!;
  const registrations = [...options.replica.schemas, ...options.replica.localSchemas];
  let views: Map<string, LofiSqliteViews> | undefined;
  return {
    replica,
    withViews: (operation: (views: ReadonlyMap<string, LofiSqliteViews>) => void) =>
      replica.read(async (locked) => {
        // A read takes the lock that the engines' synchronous statements need.
        await locked.execute(`SELECT 1 FROM "sqlite_schema" LIMIT 1`);
        views ??= new Map(
          [...engines].map(([kind, engine]) => [kind, engine.open({ connection, registrations })]),
        );
        operation(views);
      }),
  };
}

/**
 * Names the tabs that share a leader: those replicating one backend with the same schemas, which
 * open the same database. Tabs running another version of the schemas keep a replica of their own;
 * tabs running another version of a rebuildable projection share the leader's.
 */
function tabGroupName(options: LofiSqliteReplicaOptions): string {
  const schemas = registrationsNamingReplica(options)
    .map((registration) => `${registeredSchemaName(registration)}@${registration.schema.version}`)
    .sort((left, right) => left.localeCompare(right));
  return `fragno-lofi-sqlite:${JSON.stringify([resolveFragnoInternalUrls(options.baseUrl).baseUrl, schemas])}`;
}

function leaderLockName(group: string): string {
  return `${group}:leader`;
}

function tabLockName(group: string, tab: string): string {
  return `${group}:tab:${tab}`;
}

function tabChannelName(group: string, tab: string): string {
  return `${group}:tab:${tab}`;
}

function viewKey(tab: string, id: number): string {
  return `${tab}/${id}`;
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
