import { mkdirSync } from "node:fs";
import path from "node:path";
import { deserialize, serialize } from "node:v8";

import Database from "better-sqlite3";

import type { BackofficeObjectAlarm } from "../local-durable-objects";
import { configureBackofficeSqliteConnection } from "./sqlite-connection-config";

/** Narrow claims fence initialization and alarm work, never ordinary SQL operations. */
export type SqliteObjectClaim =
  | { kind: "initialization"; token: number }
  | { kind: "alarm"; token: number; alarmGeneration: number };

/** Stores authoritative object values, alarms, and narrow coordination claims in SQLite. */
export class SqliteBackofficeObjectStorage {
  readonly #database: Database.Database;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.#database = new Database(path.join(directory, "objects.sqlite"));
    configureBackofficeSqliteConnection(this.#database);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS object_instances (
        object_id TEXT PRIMARY KEY,
        alarm_generation INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS object_values (
        object_id TEXT NOT NULL REFERENCES object_instances(object_id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value BLOB NOT NULL,
        PRIMARY KEY (object_id, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS object_alarms (
        object_id TEXT PRIMARY KEY REFERENCES object_instances(object_id) ON DELETE CASCADE,
        timestamp INTEGER NOT NULL,
        generation INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS object_alarms_due ON object_alarms(timestamp, object_id);
      CREATE TABLE IF NOT EXISTS object_coordination_claims (
        object_id TEXT NOT NULL REFERENCES object_instances(object_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('initialization', 'alarm')),
        owner_id TEXT NOT NULL,
        token INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (object_id, kind)
      ) STRICT;
    `);
  }

  registerObject(id: string): void {
    this.#database.prepare("INSERT OR IGNORE INTO object_instances (object_id) VALUES (?)").run(id);
  }

  objectIds(): string[] {
    return (
      this.#database.prepare("SELECT object_id FROM object_instances ORDER BY object_id").all() as {
        object_id: string;
      }[]
    ).map((row) => row.object_id);
  }

  get(id: string, key: string): unknown {
    const row = this.#database
      .prepare("SELECT value FROM object_values WHERE object_id = ? AND key = ?")
      .get(id, key) as { value: Buffer } | undefined;
    return row ? deserialize(row.value) : undefined;
  }

  getMany<T>(id: string, keys: readonly string[]): Map<string, T> {
    const result = new Map<string, T>();
    const select = this.#database.prepare(
      "SELECT value FROM object_values WHERE object_id = ? AND key = ?",
    );
    return this.#database
      .transaction(() => {
        for (const key of keys) {
          const row = select.get(id, key) as { value: Buffer } | undefined;
          result.set(key, row ? (deserialize(row.value) as T) : (undefined as T));
        }
        return result;
      })
      .deferred();
  }

  list<T>(id: string, prefix: string | null): Map<string, T> {
    const rows = this.#database
      .prepare("SELECT key, value FROM object_values WHERE object_id = ? ORDER BY key")
      .all(id) as { key: string; value: Buffer }[];
    return new Map(
      rows
        .filter((row) => prefix === null || row.key.startsWith(prefix))
        .map((row) => [row.key, deserialize(row.value) as T]),
    );
  }

  put(
    id: string,
    claims: readonly SqliteObjectClaim[],
    entries: ReadonlyMap<string, unknown>,
  ): void {
    const insert = this.#database.prepare(
      "INSERT OR REPLACE INTO object_values (object_id, key, value) VALUES (?, ?, ?)",
    );
    this.#database
      .transaction(() => {
        this.#assertClaims(id, claims);
        for (const [key, value] of entries) {
          insert.run(id, key, serialize(value));
        }
      })
      .immediate();
  }

  delete(id: string, claims: readonly SqliteObjectClaim[], keys: readonly string[]): boolean {
    const remove = this.#database.prepare(
      "DELETE FROM object_values WHERE object_id = ? AND key = ?",
    );
    return this.#database
      .transaction(() => {
        this.#assertClaims(id, claims);
        let deleted = false;
        for (const key of keys) {
          deleted = remove.run(id, key).changes > 0 || deleted;
        }
        return deleted;
      })
      .immediate();
  }

  alarm(id: string): BackofficeObjectAlarm | null {
    const row = this.#database
      .prepare("SELECT timestamp, generation FROM object_alarms WHERE object_id = ?")
      .get(id) as BackofficeObjectAlarm | undefined;
    return row ?? null;
  }

  setAlarm(id: string, claims: readonly SqliteObjectClaim[], timestamp: number | null): void {
    const alarmClaim = claims.find((claim) => claim.kind === "alarm");
    const generation = this.#database
      .transaction(() => {
        this.#assertClaims(id, claims);
        // A request may schedule new work while an alarm awaits external I/O. The older handler
        // must not delete or postpone that request's alarm, including after it was cancelled.
        if (alarmClaim) {
          const current = this.#database
            .prepare("SELECT alarm_generation FROM object_instances WHERE object_id = ?")
            .get(id) as { alarm_generation: number };
          if (current.alarm_generation !== alarmClaim.alarmGeneration) {
            return null;
          }
        }
        const generation = (
          this.#database
            .prepare(
              `UPDATE object_instances
             SET alarm_generation = alarm_generation + 1
             WHERE object_id = ?
             RETURNING alarm_generation`,
            )
            .get(id) as { alarm_generation: number }
        ).alarm_generation;
        if (timestamp === null) {
          this.#database.prepare("DELETE FROM object_alarms WHERE object_id = ?").run(id);
        } else {
          this.#database
            .prepare(
              `INSERT INTO object_alarms (object_id, timestamp, generation) VALUES (?, ?, ?)
             ON CONFLICT(object_id) DO UPDATE SET
               timestamp = excluded.timestamp,
               generation = excluded.generation`,
            )
            .run(id, timestamp, generation);
        }
        return generation;
      })
      .immediate();
    if (alarmClaim && generation !== null) {
      alarmClaim.alarmGeneration = generation;
    }
  }

  acknowledgeAlarm(id: string, claim: SqliteObjectClaim, generation: number): boolean {
    return this.#database
      .transaction(() => {
        this.#assertClaims(id, [claim]);
        return (
          this.#database
            .prepare("DELETE FROM object_alarms WHERE object_id = ? AND generation = ?")
            .run(id, generation).changes > 0
        );
      })
      .immediate();
  }

  acquireClaim(
    id: string,
    ownerId: string,
    durationMs: number,
    target: { kind: "initialization" } | { kind: "alarm"; alarm: BackofficeObjectAlarm },
  ): SqliteObjectClaim | null {
    return this.#database
      .transaction((): SqliteObjectClaim | null => {
        this.registerObject(id);
        const { kind } = target;
        if (target.kind === "alarm" && this.alarm(id)?.generation !== target.alarm.generation) {
          return null;
        }
        const now = this.#databaseNow();
        const existing = this.#database
          .prepare(
            `SELECT token, active, expires_at
           FROM object_coordination_claims
           WHERE object_id = ? AND kind = ?`,
          )
          .get(id, kind) as { token: number; active: number; expires_at: number } | undefined;
        if (existing?.active === 1 && existing.expires_at > now) {
          return null;
        }

        const token = (existing?.token ?? 0) + 1;
        this.#database
          .prepare(
            `INSERT INTO object_coordination_claims (object_id, kind, owner_id, token, active, expires_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(object_id, kind) DO UPDATE SET
             owner_id = excluded.owner_id,
             token = excluded.token,
             active = 1,
             expires_at = excluded.expires_at`,
          )
          .run(id, kind, ownerId, token, now + durationMs);
        return target.kind === "alarm"
          ? { kind: "alarm", token, alarmGeneration: target.alarm.generation }
          : { kind: "initialization", token };
      })
      .immediate();
  }

  renewClaim(id: string, ownerId: string, claim: SqliteObjectClaim, durationMs: number): boolean {
    // An expired token must never become valid again, even before another owner takes over.
    return (
      this.#database
        .prepare(
          `UPDATE object_coordination_claims
           SET expires_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
           WHERE object_id = ? AND kind = ? AND owner_id = ? AND token = ? AND active = 1
             AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`,
        )
        .run(durationMs, id, claim.kind, ownerId, claim.token).changes > 0
    );
  }

  releaseClaim(id: string, ownerId: string, claim: SqliteObjectClaim): void {
    this.#database
      .prepare(
        `UPDATE object_coordination_claims
         SET active = 0, expires_at = 0
         WHERE object_id = ? AND kind = ? AND owner_id = ? AND token = ?`,
      )
      .run(id, claim.kind, ownerId, claim.token);
  }

  close(): void {
    this.#database.close();
  }

  hasInitializationClaim(id: string): boolean {
    return Boolean(
      this.#database
        .prepare(
          `SELECT 1 FROM object_coordination_claims
       WHERE object_id = ? AND kind = 'initialization' AND active = 1 AND expires_at > ?`,
        )
        .get(id, this.#databaseNow()),
    );
  }

  #assertClaims(id: string, claims: readonly SqliteObjectClaim[]): void {
    // Ordinary writes have no claim. Claimed async work must fence its writes in this transaction.
    for (const claim of claims) {
      const held = this.#database
        .prepare(
          `SELECT 1 FROM object_coordination_claims
         WHERE object_id = ? AND kind = ? AND token = ? AND active = 1 AND expires_at > ?`,
        )
        .get(id, claim.kind, claim.token, this.#databaseNow());
      if (!held) {
        throw new Error(`BACKOFFICE_OBJECT_CLAIM_LOST:${id}:${claim.kind}`);
      }
    }
  }

  #databaseNow(): number {
    return (
      this.#database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get() as {
        now: number;
      }
    ).now;
  }
}
