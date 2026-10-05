import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import type { GraftDatabaseOperations } from "../graft/graft-database-operations";
import type { GraftNodeAuthorityWindow } from "../graft/graft-node-authority";
import {
  assertGraftObjectAuthority,
  type GraftObjectActivationAuthority,
} from "../graft/graft-object-authority";
import type { NodeDurableObjectSqlValue } from "../runtime/node-durable-object-storage";
import {
  readNodeRuntimeEpochMilliseconds,
  readNodeRuntimeMonotonicMilliseconds,
  type NodeRuntimeClock,
} from "../runtime/node-runtime-clock";

type NodeRuntimeSqlValue = null | number | bigint | string | Uint8Array;

type NodeRuntimeSqlMutationResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type NodeRuntimeObjectDatabaseSession = {
  run(sql: string, parameters: readonly NodeRuntimeSqlValue[]): NodeRuntimeSqlMutationResult;
  get(sql: string, parameters: readonly NodeRuntimeSqlValue[]): Record<string, unknown> | null;
  all(sql: string, parameters: readonly NodeRuntimeSqlValue[]): Record<string, unknown>[];
};

export type NodeRuntimeSqlExecution = {
  rows: Record<string, unknown>[];
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
};

type NodeRuntimeObjectDatabaseDurability = {
  operations: GraftDatabaseOperations;
  authority: GraftObjectActivationAuthority;
  clock: NodeRuntimeClock;
};

type ActiveDatabaseSession = {
  session: NodeRuntimeObjectDatabaseSession;
  deactivate(): void;
};

/** Owns the SQLite connection and keeps Graft durability outside object author control. */
export class ManagedNodeRuntimeObjectDatabase {
  readonly #database: DatabaseSync;
  readonly #durability: NodeRuntimeObjectDatabaseDurability;
  #committedStoragePosition = 0;
  #durableStoragePosition = 0;
  #failure: Error | null = null;

  constructor(database: DatabaseSync, durability: NodeRuntimeObjectDatabaseDurability) {
    this.#database = database;
    this.#durability = durability;
  }

  read<TResult>(operation: (database: NodeRuntimeObjectDatabaseSession) => TResult): TResult {
    this.#requireUsable();
    const active = this.#createSession("read");
    try {
      const result = operation(active.session);
      this.#assertSynchronousOperation(result);
      return result;
    } finally {
      active.deactivate();
    }
  }

  write<TResult>(operation: (database: NodeRuntimeObjectDatabaseSession) => TResult): TResult {
    this.#requireUsable();
    const active = this.#createSession("write");
    this.#database.exec("BEGIN IMMEDIATE");
    let result: TResult;
    try {
      result = operation(active.session);
      this.#assertSynchronousOperation(result);
      this.#database.exec("COMMIT");
      this.#committedStoragePosition += 1;
    } catch (error) {
      if (this.#database.isTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw error;
    } finally {
      active.deactivate();
    }
    return result;
  }

  executeSql(
    query: string,
    bindings: readonly NodeDurableObjectSqlValue[],
  ): NodeRuntimeSqlExecution {
    assertObjectAuthorSql(query);
    const operation = applicationSqlOperation(query);
    const parameters = bindings.map(toNodeSqlValue);
    if (operation === "select") {
      return this.read(() => this.#executeStatement(query, parameters, false));
    }
    return this.write(() => this.#executeStatement(query, parameters, true));
  }

  get databaseSize(): number {
    this.#requireUsable();
    const pageCount = readPragmaNumber(this.#database, "PRAGMA page_count");
    const pageSize = readPragmaNumber(this.#database, "PRAGMA page_size");
    return pageCount * pageSize;
  }

  /** Returns the latest local commit position that an object output can reveal. */
  get committedStoragePosition(): number {
    this.#requireUsable();
    return this.#committedStoragePosition;
  }

  /** Proves the requested object storage position durable before external output is released. */
  ensureDurableStoragePosition(requiredPosition: number): void {
    this.#requireUsable();
    if (this.#durableStoragePosition >= requiredPosition) {
      return;
    }
    if (requiredPosition > this.#committedStoragePosition) {
      throw new Error(
        `NODE_RUNTIME_OBJECT_DATABASE_POSITION_INVALID:${requiredPosition}:${this.#committedStoragePosition}`,
      );
    }
    const pushTarget = this.#committedStoragePosition;
    try {
      this.#durability.operations.push(this.#database);
      this.#durableStoragePosition = pushTarget;
    } catch (cause) {
      this.#failure = new Error("NODE_RUNTIME_OBJECT_DATABASE_DURABILITY_UNCERTAIN", { cause });
      throw this.#failure;
    }
    this.#assertOutputAuthority();
  }

  /** Never extends an already expired or poisoned activation, even after late confirmation. */
  advanceNodeAuthorityWindow(next: GraftNodeAuthorityWindow): void {
    this.#requireUsable();
    const authority = this.#durability.authority;
    const previous = authority.nodeAuthority;
    if (
      next.nodeId !== authority.ownerNodeId ||
      next.processGeneration !== authority.processGeneration ||
      next.leaseExpiresAtEpochMs < previous.leaseExpiresAtEpochMs ||
      next.selfFenceAtMonotonicMs < previous.selfFenceAtMonotonicMs ||
      (next.renewalId === previous.renewalId &&
        (next.leaseExpiresAtEpochMs !== previous.leaseExpiresAtEpochMs ||
          next.selfFenceAtMonotonicMs !== previous.selfFenceAtMonotonicMs)) ||
      (next.renewalId !== previous.renewalId &&
        (next.selfFenceAtMonotonicMs === previous.selfFenceAtMonotonicMs ||
          next.leaseExpiresAtEpochMs === previous.leaseExpiresAtEpochMs))
    ) {
      this.#failure = new Error("NODE_RUNTIME_OBJECT_AUTHORITY_WINDOW_INVALID");
      throw this.#failure;
    }
    authority.nodeAuthority = next;
  }

  close(): void {
    this.#database.close();
  }

  #assertOutputAuthority(): void {
    try {
      assertGraftObjectAuthority(this.#database, this.#durability.authority);
      if (
        this.#durability.authority.nodeAuthority.selfFenceAtMonotonicMs <=
          readNodeRuntimeMonotonicMilliseconds(this.#durability.clock) ||
        this.#durability.authority.nodeAuthority.leaseExpiresAtEpochMs <=
          readNodeRuntimeEpochMilliseconds(this.#durability.clock)
      ) {
        throw new Error("NODE_RUNTIME_OBJECT_AUTHORITY_EXPIRED");
      }
    } catch (cause) {
      this.#failure =
        cause instanceof Error
          ? cause
          : new Error("NODE_RUNTIME_OBJECT_AUTHORITY_INVALID", { cause });
      throw this.#failure;
    }
  }

  #executeStatement(
    query: string,
    parameters: readonly NodeRuntimeSqlValue[],
    mutation: boolean,
  ): NodeRuntimeSqlExecution {
    assertApplicationSql(query, mutation ? "write" : "read");
    const statement = this.#database.prepare(query);
    assertSingleApplicationSqlStatement(query, statement.sourceSQL);
    const columnNames = statement.columns().map((column) => column.name);
    const rows = statement.all(...parameters) as Record<string, unknown>[];
    const rowsWritten = mutation
      ? ((this.#database.prepare("SELECT changes() AS changes").get() as { changes: number })
          .changes ?? 0)
      : 0;
    return {
      rows,
      columnNames,
      rowsRead: rows.length,
      rowsWritten,
    };
  }

  #createSession(mode: "read" | "write"): ActiveDatabaseSession {
    let active = true;
    const prepare = (sql: string) => {
      if (!active) {
        throw new Error("NODE_RUNTIME_OBJECT_DATABASE_SESSION_CLOSED");
      }
      assertApplicationSql(sql, mode);
      return this.#database.prepare(sql);
    };
    return {
      session: {
        run: (sql, parameters) => mutationResult(prepare(sql).run(...parameters)),
        get: (sql, parameters) =>
          (prepare(sql).get(...parameters) as Record<string, unknown> | undefined) ?? null,
        all: (sql, parameters) => prepare(sql).all(...parameters) as Record<string, unknown>[],
      },
      deactivate() {
        active = false;
      },
    };
  }

  #assertSynchronousOperation(result: unknown): void {
    if (!isThenable(result)) {
      return;
    }
    // Async callbacks cannot be cancelled, but their captured SQL session closes before resumption.
    void Promise.resolve(result).catch(() => {});
    throw new Error("NODE_RUNTIME_OBJECT_DATABASE_ASYNC_TRANSACTION");
  }

  #requireUsable(): void {
    if (this.#failure) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_POISONED", { cause: this.#failure });
    }
    this.#assertOutputAuthority();
  }
}

/** Owns a previously fenced object clone and rejects output after its exact authority expires. */
export function manageAuthorityBoundGraftObjectDatabase(
  database: DatabaseSync,
  operations: GraftDatabaseOperations,
  authority: GraftObjectActivationAuthority,
  clock: NodeRuntimeClock,
): ManagedNodeRuntimeObjectDatabase {
  return new ManagedNodeRuntimeObjectDatabase(database, {
    operations,
    authority,
    clock,
  });
}

function mutationResult(result: StatementResultingChanges): NodeRuntimeSqlMutationResult {
  return {
    changes: Number(result.changes),
    lastInsertRowid: result.lastInsertRowid,
  };
}

function applicationSqlOperation(sql: string): string {
  const withoutLeadingComments = sql
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .trimStart();
  const operation = /^([a-z]+)/i.exec(withoutLeadingComments)?.[1]?.toLowerCase() ?? "";
  if (
    operation !== "alter" &&
    operation !== "create" &&
    operation !== "delete" &&
    operation !== "drop" &&
    operation !== "insert" &&
    operation !== "replace" &&
    operation !== "select" &&
    operation !== "update" &&
    operation !== "with"
  ) {
    throw new Error(`NODE_RUNTIME_OBJECT_DATABASE_SQL_FORBIDDEN:${operation || "unknown"}`);
  }
  return operation;
}

function assertObjectAuthorSql(sql: string): void {
  if (/\bnode_runtime_[a-z0-9_]*\b/i.test(sql)) {
    throw new Error("NODE_RUNTIME_OBJECT_DATABASE_RUNTIME_SQL_FORBIDDEN");
  }
}

function assertApplicationSql(sql: string, mode: "read" | "write"): void {
  const operation = applicationSqlOperation(sql);
  if (mode === "read" && operation !== "select") {
    throw new Error(`NODE_RUNTIME_OBJECT_DATABASE_READ_SQL_FORBIDDEN:${operation}`);
  }
}

function assertSingleApplicationSqlStatement(query: string, sourceSql: string): void {
  const trailingSql = query
    .slice(sourceSql.length)
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  if (trailingSql.length > 0) {
    throw new Error("NODE_DURABLE_OBJECT_SQL_MULTIPLE_STATEMENTS_FORBIDDEN");
  }
}

function toNodeSqlValue(value: NodeDurableObjectSqlValue): NodeRuntimeSqlValue {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function readPragmaNumber(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number") {
    throw new Error(`NODE_RUNTIME_OBJECT_DATABASE_PRAGMA_RESULT_INVALID:${sql}`);
  }
  return value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
