import type { ArtifactSiteDataStatus } from "@fragno-dev/backoffice-api/v0/artifacts";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { fetchFragnoInternalDescription, resolveFragnoInternalUrls } from "@fragno-dev/db/outbox";
import {
  LOFI_SQLITE_LAYOUT_VERSION,
  quoteSqliteIdentifier,
  registeredSchemaName,
  SqliteLofiAdapter,
  type LofiSqliteDatabase,
  type SqliteValue,
} from "@fragno-dev/lofi/sqlite";

import { LofiClient } from "@fragno-dev/lofi";

import {
  describeSiteDataError,
  SITE_DATA_LIMITS,
  siteDataQueryProblem,
  type SiteDataQuery,
  type SiteDataResult,
} from "@/artifacts/sites/site-data";
import type { SiteReplicaCommands } from "@/backoffice-runtime/object-registry";
import {
  AUTOMATION_PAGE_RELATIONS,
  AUTOMATION_PAGE_VIEWS_SQL,
} from "@/fragno/automation/lofi/page-relations";
import { AUTOMATION_REPLICA_SCHEMAS } from "@/fragno/automation/lofi/replica-schemas";

/** Rows a statement returns as it is iterated, each as its values in the columns' order. */
export type SiteReplicaCursor = Iterable<SqliteValue[]> & {
  readonly columnNames: readonly string[];
  /** Rows the statement wrote so far. */
  readonly rowsWritten: number;
};

/** What the copy is kept in: a Durable Object's SQLite, or SQLite in Node. */
export type SiteReplicaStorage = {
  /** Runs `sql`, which may hold several statements when it binds nothing, synchronously. */
  exec(sql: string, params?: readonly SqliteValue[]): SiteReplicaCursor;
  /** Runs `operation` in one transaction: it commits when it resolves, and rolls back otherwise. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /** Removes everything stored. */
  deleteAll(): Promise<void>;
  /** The size of everything stored, in bytes. */
  databaseSize(): number;
};

/** The object's alarm, which wakes it to catch up when no site reads. */
export type SiteReplicaAlarm = {
  get(): Promise<number | null>;
  set(scheduledTime: number): Promise<void>;
};

/** Automations serves its outbox below this mount; the origin is never dialed. */
const AUTOMATIONS_BASE_URL = "http://automations.internal/api/automations";

const META_TABLE = "site_replica_meta";
/** How long the outbox stream stays open after the last read. */
const STREAM_IDLE_MS = 60_000;
/** How long one alarm follows the stream toward catching up before the next alarm goes on. */
const CATCH_UP_SLICE_MS = 30_000;
/** How long the copy waits to try again after one, two, and more failures in a row. */
const RETRY_DELAYS_MS = [5_000, 30_000, 300_000];
/** Failed attempts in a row, about a day of them, after which only a read tries again. */
const RETRIES = 300;
const RELATIONS = AUTOMATION_PAGE_RELATIONS.map((relation) => relation.name);
const ROLLBACK = new Error("Rolls the read back.");

/**
 * How a catch-up an alarm waits for ended: caught up, or failed with the next attempt being set,
 * which the alarm waits for.
 */
type CatchUpSettled = { outcome: "caught-up" } | { outcome: "failed"; retrying: Promise<void> };

type Replica = {
  adapter: SqliteLofiAdapter;
  client: LofiClient;
  /** Whether the copy ever held everything Automations had, which a first catch-up ends. */
  caughtUp: boolean;
  streaming: boolean;
  /** Whether the stream that is open replayed what Automations held when it opened. */
  live: boolean;
  /** How much of the stream's replay was applied, while it replays. */
  progress: number | null;
  /** Alarms waiting for the stream to replay what it opened behind, or to fail. */
  waiting: Set<(settled: CatchUpSettled) => void>;
  idle: ReturnType<typeof setTimeout> | null;
};

/**
 * A copy of one scope's Automations data, which site Workers read with SQL as pages read theirs:
 * the replica's tables, kept by the code that keeps a browser's, the page relations as views of
 * them, and the relations pages compute in JavaScript as tables. It lives apart from Automations,
 * so catching up, and the queries sites run, never hold up the scope's automations.
 *
 * The copy follows Automations' outbox stream while sites read it, and for a minute after, applying
 * what arrives in the background; reads answer from what it holds. Until it first held everything
 * Automations had, reads answer that it is catching up, and the site is unavailable.
 *
 * Catching up does not wait for reads: a site's build, or a read that finds the copy behind, sets
 * the object's alarm, which follows the stream until it replayed what it opened behind, a slice of
 * time at a time, so a large first copy survives the object being evicted between reads. A failure
 * sets the alarm to try again, later after each failure in a row.
 */
export class SiteReplicaObject implements SiteReplicaCommands {
  readonly #storage: SiteReplicaStorage;
  readonly #alarm: SiteReplicaAlarm;
  readonly #now: () => number;
  readonly #fetchAutomations: (scope: BackofficeContextScope) => typeof fetch;
  #scope: BackofficeContextScope | null = null;
  #replica: Promise<Replica> | null = null;
  /** The replica being opened or open, once opening succeeded, for reporting on it. */
  #opened: Replica | null = null;
  /** Whether the meta table exists; deleting everything deletes it. */
  #metaReady = false;

  constructor(options: {
    storage: SiteReplicaStorage;
    alarm: SiteReplicaAlarm;
    now?: () => number;
    fetchAutomations: (scope: BackofficeContextScope) => typeof fetch;
  }) {
    this.#storage = options.storage;
    this.#alarm = options.alarm;
    this.#now = options.now ?? Date.now;
    this.#fetchAutomations = options.fetchAutomations;
  }

  async query(scope: BackofficeContextScope, query: SiteDataQuery): Promise<SiteDataResult> {
    this.#claim(scope);
    const problem = siteDataQueryProblem(query);
    if (problem !== null) {
      return { status: "error", message: problem };
    }
    const replica = await this.#replicaFor(scope);
    this.#follow(replica);
    if (!replica.caughtUp) {
      await this.#catchUpSoon();
      return { status: "catching-up" };
    }
    // The adapter runs the read between its writes, so it never sees an outbox batch half applied.
    let result: SiteDataResult | null = null;
    try {
      await replica.adapter.read(async () => {
        result = this.#read(query);
        // A query that wrote anything, through what the checks above let pass, keeps none of it.
        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) {
        throw error;
      }
    }
    return result ?? { status: "error", message: "The read did not run." };
  }

  async warm(scope: BackofficeContextScope): Promise<void> {
    this.#claim(scope);
    if (this.#meta("caught-up") !== "true") {
      await this.#catchUpSoon();
    }
  }

  async status(scope: BackofficeContextScope): Promise<ArtifactSiteDataStatus> {
    this.#claim(scope);
    const replica = this.#opened;
    const caughtUp = replica?.caughtUp ?? this.#meta("caught-up") === "true";
    const retryAt = await this.#alarm.get();
    const lastError = this.#meta("last-error");
    const appliedAt = this.#meta("applied-at");
    return {
      status:
        this.#meta("failing") !== null
          ? "failing"
          : caughtUp
            ? "caught-up"
            : this.#meta("replica") !== null || retryAt !== null
              ? "catching-up"
              : "not-started",
      available: caughtUp,
      following: replica?.streaming ?? false,
      progress: replica?.progress ?? null,
      lastAppliedAt: appliedAt === null ? null : new Date(Number(appliedAt)).toISOString(),
      lastError:
        lastError === null ? null : (JSON.parse(lastError) as { message: string; at: string }),
      retryAt: retryAt === null ? null : new Date(retryAt).toISOString(),
      sizeBytes: this.#storage.databaseSize(),
    };
  }

  /**
   * Follows the stream until it replayed what it opened behind, for a slice of time, and sets the
   * alarm again when the slice ends first: at once, or later while the stream keeps failing. A
   * stream that stopped set the alarm when it stopped.
   */
  async alarm(): Promise<void> {
    const stored = this.#meta("scope");
    if (stored === null) {
      return;
    }
    const scope = JSON.parse(stored) as BackofficeContextScope;
    this.#claim(scope);
    let replica: Replica;
    try {
      replica = await this.#replicaFor(scope);
    } catch (error) {
      // Opening failed and the next attempt is set; anything else fails the alarm, which runs again.
      if (error instanceof SiteReplicaOpenFailed) {
        return;
      }
      throw error;
    }
    this.#follow(replica);
    if (replica.live) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settle!: (settled: CatchUpSettled) => void;
    const settled = await new Promise<CatchUpSettled | { outcome: "behind" }>((resolve) => {
      settle = resolve;
      replica.waiting.add(settle);
      timeout = setTimeout(() => {
        resolve({ outcome: "behind" });
      }, CATCH_UP_SLICE_MS);
    });
    clearTimeout(timeout);
    replica.waiting.delete(settle);
    if (settled.outcome === "failed") {
      // An alarm that cannot set the next one fails, so the runtime runs it again.
      await settled.retrying;
    } else if (settled.outcome === "behind") {
      if (this.#meta("failing") === null) {
        await this.#alarm.set(this.#now());
      } else {
        await this.#retryLater();
      }
    }
  }

  #claim(scope: BackofficeContextScope) {
    if (this.#scope !== null) {
      if (JSON.stringify(this.#scope) !== JSON.stringify(scope)) {
        throw new Error("A site replica serves only the scope it was first asked for.");
      }
      return;
    }
    this.#scope = scope;
    // The alarm wakes the object without a request, so it reads the scope it catches up from here.
    this.#setMeta("scope", JSON.stringify(scope));
  }

  async #replicaFor(scope: BackofficeContextScope): Promise<Replica> {
    this.#replica ??= this.#open(scope).catch(async (error: unknown) => {
      this.#replica = null;
      this.#recordError(error);
      await this.#retryLater();
      throw new SiteReplicaOpenFailed(error);
    });
    return await this.#replica;
  }

  /** Sets the alarm to catch up at once, unless it is set already. */
  async #catchUpSoon() {
    if ((await this.#alarm.get()) === null) {
      await this.#alarm.set(this.#now());
    }
  }

  /** Marks the copy failing until it next applies a change or catches up. */
  #recordError(error: unknown) {
    this.#setMeta("failing", "true");
    this.#setMeta(
      "last-error",
      JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        at: new Date(this.#now()).toISOString(),
      }),
    );
  }

  /** Counts a failed attempt, and sets the alarm to try again unless they failed for about a day. */
  async #retryLater() {
    const failures = Number(this.#meta("failures") ?? 0) + 1;
    this.#setMeta("failures", String(failures));
    if (failures <= RETRIES) {
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
      await this.#alarm.set(this.#now() + delay);
    }
  }

  #succeeded() {
    if (this.#meta("failing") !== null || this.#meta("failures") !== null) {
      this.#setMeta("failing", null);
      this.#setMeta("failures", null);
    }
  }

  /** Follows the outbox stream, if it is not already, until a minute passes without reads. */
  #follow(replica: Replica) {
    if (!replica.streaming) {
      replica.streaming = true;
      replica.live = false;
      replica.client.start();
    }
    if (replica.idle !== null) {
      clearTimeout(replica.idle);
    }
    replica.idle = setTimeout(() => {
      this.#stop(replica);
    }, STREAM_IDLE_MS);
  }

  #stop(replica: Replica) {
    if (replica.idle !== null) {
      clearTimeout(replica.idle);
      replica.idle = null;
    }
    replica.streaming = false;
    replica.live = false;
    replica.client.stop();
  }

  async #open(scope: BackofficeContextScope): Promise<Replica> {
    const fetchAutomations = this.#fetchAutomations(scope);
    const urls = resolveFragnoInternalUrls(AUTOMATIONS_BASE_URL);
    const { adapterIdentity } = await fetchFragnoInternalDescription({
      internalUrl: urls.internal,
      fetch: fetchAutomations,
    });
    // As a browser's replica does, a copy never migrates: a replaced backend, or a changed layout
    // or schema, starts it over from the outbox's beginning.
    const key = JSON.stringify({
      adapterIdentity,
      layoutVersion: LOFI_SQLITE_LAYOUT_VERSION,
      schemas: AUTOMATION_REPLICA_SCHEMAS.map((registration) => ({
        name: registeredSchemaName(registration),
        version: registration.schema.version,
      })).sort((left, right) => left.name.localeCompare(right.name)),
    });
    if (this.#meta("replica") !== key) {
      const alarm = await this.#alarm.get();
      await this.#storage.deleteAll();
      this.#metaReady = false;
      this.#setMeta("replica", key);
      this.#setMeta("scope", JSON.stringify(scope));
      // Deleting everything may delete the alarm too.
      if (alarm !== null) {
        await this.#alarm.set(alarm);
      }
    }

    const adapter = await SqliteLofiAdapter.open({
      database: lofiDatabase(this.#storage),
      schemas: AUTOMATION_REPLICA_SCHEMAS,
      localSchemas: [],
      projections: [],
    });
    // Durable Object SQLite has no temporary views, so the relations are kept in the copy itself,
    // and created again whenever the object starts, in case their code changed.
    for (const [name, select] of Object.entries(AUTOMATION_PAGE_VIEWS_SQL)) {
      this.#storage.exec(`DROP VIEW IF EXISTS ${quoteSqliteIdentifier(name)}`);
      this.#storage.exec(`CREATE VIEW ${quoteSqliteIdentifier(name)} AS ${select}`);
    }
    const replica: Replica = {
      adapter,
      client: undefined as unknown as LofiClient,
      caughtUp: this.#meta("caught-up") === "true",
      streaming: false,
      live: false,
      progress: null,
      waiting: new Set(),
      idle: null,
    };
    replica.client = new LofiClient({
      outboxUrl: urls.outbox.toString(),
      outboxStreamUrl: urls.outboxStream.toString(),
      outboxTransport: "stream",
      endpointName: "site-replica",
      adapter,
      fetch: fetchAutomations,
      onSyncApplied: () => {
        this.#setMeta("applied-at", String(this.#now()));
        this.#succeeded();
      },
      onCatchUp: (progress) => {
        if (progress.status === "catching-up") {
          replica.progress = progress.fraction;
          return;
        }
        replica.progress = null;
        replica.live = true;
        this.#succeeded();
        if (!replica.caughtUp) {
          replica.caughtUp = true;
          this.#setMeta("caught-up", "true");
        }
        settle(replica, { outcome: "caught-up" });
      },
      // The client reconnects after errors reading the stream, and stops after any other.
      onError: (error) => {
        console.error("A site replica failed to follow its scope's outbox.", error);
        this.#recordError(error);
      },
      onStopped: () => {
        replica.streaming = false;
        replica.live = false;
        const awaited = replica.waiting.size > 0;
        const retrying = this.#retryLater();
        settle(replica, { outcome: "failed", retrying });
        // Waiting alarms fail with it; without one, the next read sets the alarm again.
        retrying.catch((error: unknown) => {
          if (!awaited) {
            console.error("A site replica could not set its alarm to try again.", error);
          }
        });
      },
    });
    this.#opened = replica;
    return replica;
  }

  #setMeta(key: string, value: string | null) {
    this.#metaTable();
    if (value === null) {
      this.#storage.exec(`DELETE FROM ${META_TABLE} WHERE "key" = ?`, [key]);
    } else {
      this.#storage.exec(`INSERT OR REPLACE INTO ${META_TABLE} VALUES (?, ?)`, [key, value]);
    }
  }

  #meta(key: string): string | null {
    this.#metaTable();
    const [row] = [
      ...this.#storage.exec(`SELECT "value" FROM ${META_TABLE} WHERE "key" = ?`, [key]),
    ];
    return typeof row?.[0] === "string" ? row[0] : null;
  }

  /** Creates the meta table, which an object that never opened a copy lacks. */
  #metaTable() {
    if (!this.#metaReady) {
      this.#storage.exec(
        `CREATE TABLE IF NOT EXISTS ${META_TABLE} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
      );
      this.#metaReady = true;
    }
  }

  #read(query: SiteDataQuery): SiteDataResult {
    try {
      const cursor = this.#storage.exec(query.sql, query.params);
      const rows: SqliteValue[][] = [];
      let bytes = 0;
      for (const row of cursor) {
        if (rows.length === SITE_DATA_LIMITS.rows) {
          return {
            status: "error",
            message: `The query returns more than ${SITE_DATA_LIMITS.rows} rows; add a LIMIT.`,
          };
        }
        bytes += row.reduce((total: number, value) => total + byteSize(value), 0);
        if (bytes > SITE_DATA_LIMITS.bytes) {
          return {
            status: "error",
            message: `The query returns more than ${SITE_DATA_LIMITS.bytes / 1024 / 1024} MB; select fewer columns or rows.`,
          };
        }
        rows.push(row);
      }
      if (cursor.rowsWritten > 0) {
        return { status: "error", message: "Queries only read: they cannot write." };
      }
      return { status: "ready", columns: [...cursor.columnNames], rows };
    } catch (error) {
      return { status: "error", message: describeSiteDataError(error, RELATIONS) };
    }
  }
}

/** The copy could not open, and the next attempt is set. */
class SiteReplicaOpenFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function settle(replica: Replica, settled: CatchUpSettled) {
  for (const resolve of replica.waiting) {
    resolve(settled);
  }
  replica.waiting.clear();
}

/** The copy as lofi's adapter writes it; Durable Object SQLite runs its transactions whole. */
function lofiDatabase(storage: SiteReplicaStorage): LofiSqliteDatabase {
  return {
    execute: async (sql, params = []) => rowObjects(storage.exec(sql, params as SqliteValue[])),
    transaction: (_mode, operation) => storage.transaction(operation),
  };
}

function rowObjects(cursor: SiteReplicaCursor): Record<string, SqliteValue>[] {
  return Array.from(cursor, (row) =>
    Object.fromEntries(cursor.columnNames.map((name, index) => [name, row[index]])),
  );
}

const utf8 = new TextEncoder();

function byteSize(value: SqliteValue): number {
  if (typeof value === "string") {
    return utf8.encode(value).byteLength;
  }
  return value instanceof Uint8Array ? value.byteLength : 8;
}
