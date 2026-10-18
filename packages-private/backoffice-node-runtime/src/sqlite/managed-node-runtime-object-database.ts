import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

import type { GraftDatabaseOperations } from "../graft/graft-database-operations";
import type { GraftNodeAuthorityWindow } from "../graft/graft-node-authority";
import {
  assertGraftObjectAuthority,
  type GraftObjectActivationAuthority,
} from "../graft/graft-object-authority";
import type { NodeDurableObjectSqlValue } from "../runtime/node-durable-object-storage";
import { NodeObjectInputGate } from "../runtime/node-object-input-gate";
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

type ObjectDatabaseTransaction = {
  owner: symbol;
  active: boolean;
  rolledBack: boolean;
  written: boolean;
  settled: PromiseWithResolvers<void>;
};

/** Alarm discovery participates before local commit and publishes only after a successful commit. */
export type NodeObjectTransactionCommitHooks = {
  beforeCommit(): void;
  afterCommit(): void;
};

/** Owns the SQLite connection and keeps Graft durability outside object author control. */
export class ManagedNodeRuntimeObjectDatabase {
  readonly #database: DatabaseSync;
  readonly #durability: NodeRuntimeObjectDatabaseDurability;
  #committedStoragePosition = 0;
  #durableStoragePosition = 0;
  #failure: Error | null = null;
  readonly inputGate = new NodeObjectInputGate();
  readonly #transactionContext = new AsyncLocalStorage<ObjectDatabaseTransaction>();
  #transaction: ObjectDatabaseTransaction | null = null;
  readonly #pendingTransactions = new Set<Promise<void>>();

  constructor(database: DatabaseSync, durability: NodeRuntimeObjectDatabaseDurability) {
    this.#database = database;
    this.#durability = durability;
  }

  read<TResult>(operation: (database: NodeRuntimeObjectDatabaseSession) => TResult): TResult {
    this.#requireStorageAccess();
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
    this.#requireStorageAccess();
    const transaction = this.#ownedTransaction();
    if (transaction) {
      const active = this.#createSession("write");
      this.#database.exec("SAVEPOINT node_runtime_write");
      try {
        const result = operation(active.session);
        this.#assertSynchronousOperation(result);
        this.#database.exec("RELEASE node_runtime_write");
        transaction.written = true;
        return result;
      } catch (error) {
        // A caught multi-statement storage failure must not leave partial writes in its outer transaction.
        this.#database.exec("ROLLBACK TO node_runtime_write");
        this.#database.exec("RELEASE node_runtime_write");
        throw error;
      } finally {
        active.deactivate();
      }
    }
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

  /** An object's operation and its continuations share transaction ownership, not other admitted events. */
  runStorageOperation<TResult>(operation: () => TResult): TResult {
    return this.inputGate.runOperation(operation);
  }

  /** Cleanup cancels application work without queuing its native I/O behind that work's gate. */
  runStorageMaintenance<TResult>(operation: () => TResult): TResult {
    return this.inputGate.runMaintenance(operation);
  }

  /** Queues asynchronous storage access behind another operation's transaction, never its own. */
  async access<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    while (true) {
      this.#requireUsable();
      if (this.#ownedTransaction()) {
        this.#requireStorageAccess();
        return await operation();
      }
      if (!this.#transaction) {
        return await operation();
      }
      await this.#transaction.settled.promise;
    }
  }

  /** Admission and output settlement cannot observe an open transaction, even from its owning operation. */
  async accessOutsideTransaction<TResult>(
    operation: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    while (true) {
      this.#requireUsable();
      const context = this.#transactionContext.getStore();
      if (context) {
        this.#requireStorageAccess();
        throw new Error("NODE_RUNTIME_OBJECT_DATABASE_OUTPUT_DURING_TRANSACTION");
      }
      if (this.#pendingTransactions.size > 0) {
        await Promise.all(this.#pendingTransactions);
        continue;
      }
      if (!this.#transaction) {
        return await operation();
      }
      await this.#transaction.settled.promise;
    }
  }

  get isInTransaction(): boolean {
    this.#requireStorageAccess();
    return this.#ownedTransaction() !== null;
  }

  transactionSync<TResult>(
    operation: () => TResult,
    hooks: NodeObjectTransactionCommitHooks,
  ): TResult {
    const transaction = this.#beginTransaction();
    try {
      return this.#transactionContext.run(transaction, () => {
        const result = operation();
        this.#assertSynchronousOperation(result);
        this.#commitTransaction(transaction, hooks);
        return result;
      });
    } finally {
      this.#finishTransaction(transaction);
    }
  }

  async transaction<TResult>(
    operation: () => TResult | Promise<TResult>,
    hooks: NodeObjectTransactionCommitHooks,
  ): Promise<TResult> {
    if (this.#ownedTransaction()) {
      this.#requireStorageAccess();
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_NESTED_TRANSACTION");
    }
    // Reserving exclusive admission is already pending storage work. A handler that starts a
    // transaction without awaiting it must not publish output before the deferred BEGIN runs.
    const pending = Promise.withResolvers<void>();
    this.#pendingTransactions.add(pending.promise);
    try {
      return await this.inputGate.runCriticalSection(() =>
        this.access(async () => {
          const transaction = this.#beginTransaction();
          try {
            return await this.#transactionContext.run(transaction, async () => {
              const result = await operation();
              this.#commitTransaction(transaction, hooks);
              return result;
            });
          } finally {
            this.#finishTransaction(transaction);
          }
        }),
      );
    } finally {
      this.#pendingTransactions.delete(pending.promise);
      pending.resolve();
    }
  }

  /** Explicit transaction handles retain ownership across calls, but never outlive their transaction. */
  captureTransactionRunner(): <TResult>(operation: () => TResult) => TResult {
    this.#requireStorageAccess();
    const transaction = this.#transactionContext.getStore();
    if (!transaction) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_NO_TRANSACTION");
    }
    return <TResult>(operation: () => TResult): TResult => {
      if (!transaction.active) {
        throw new Error("NODE_RUNTIME_OBJECT_DATABASE_TRANSACTION_HANDLE_CLOSED");
      }
      return this.#transactionContext.run(transaction, () => {
        this.#requireStorageAccess();
        return operation();
      });
    };
  }

  rollbackTransaction(): void {
    this.#requireStorageAccess();
    const transaction = this.#ownedTransaction();
    if (!transaction) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_NO_TRANSACTION");
    }
    transaction.rolledBack = true;
  }

  #beginTransaction(): ObjectDatabaseTransaction {
    this.#requireStorageAccess();
    if (this.#ownedTransaction()) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_NESTED_TRANSACTION");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    const transaction: ObjectDatabaseTransaction = {
      owner: this.inputGate.operationOwner ?? Symbol("node object storage transaction"),
      active: true,
      rolledBack: false,
      written: false,
      settled: Promise.withResolvers<void>(),
    };
    this.#transaction = transaction;
    return transaction;
  }

  #commitTransaction(
    transaction: ObjectDatabaseTransaction,
    hooks: NodeObjectTransactionCommitHooks,
  ): void {
    this.#requireUsable();
    if (transaction.rolledBack) {
      this.#database.exec("ROLLBACK");
      return;
    }
    hooks.beforeCommit();
    this.#database.exec("COMMIT");
    if (transaction.written) {
      this.#committedStoragePosition += 1;
    }
    transaction.active = false;
    this.#transaction = null;
    // Publication is synchronous, so another queued transaction cannot start between commit and push.
    this.#transactionContext.exit(() => {
      hooks.afterCommit();
    });
  }

  #finishTransaction(transaction: ObjectDatabaseTransaction): void {
    try {
      if (this.#database.isTransaction) {
        this.#database.exec("ROLLBACK");
      }
    } finally {
      transaction.active = false;
      this.#transaction = null;
      transaction.settled.resolve();
    }
  }

  executeSql(
    query: string,
    bindings: readonly NodeDurableObjectSqlValue[],
  ): NodeRuntimeSqlExecution {
    assertObjectAuthorSql(query);
    const migrationPragma =
      /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*pragma\s+(foreign_keys|defer_foreign_keys)\s*=\s*(on|off|0|1)\s*;?\s*$/i.exec(
        query,
      );
    if (migrationPragma) {
      this.#requireStorageAccess();
      if (bindings.length !== 0) {
        throw new Error("NODE_RUNTIME_OBJECT_DATABASE_PRAGMA_BINDINGS_FORBIDDEN");
      }
      if (migrationPragma[1].toLowerCase() === "foreign_keys" && this.#database.isTransaction) {
        throw new Error("NODE_RUNTIME_OBJECT_DATABASE_FOREIGN_KEYS_DURING_TRANSACTION");
      }
      // Connection settings are not persisted writes. foreign_keys must execute before BEGIN;
      // defer_foreign_keys belongs to the active migration transaction and resets at its end.
      this.#database.prepare(query).run();
      return { rows: [], columnNames: [], rowsRead: 0, rowsWritten: 0 };
    }
    const operation = applicationSqlOperation(query);
    const parameters = bindings.map(toNodeSqlValue);
    if (operation === "select") {
      return this.read(() => this.#executeStatement(query, parameters, false));
    }
    return this.write(() => this.#executeStatement(query, parameters, true));
  }

  get databaseSize(): number {
    this.#requireStorageAccess();
    const pageCount = readPragmaNumber(this.#database, "PRAGMA page_count");
    const pageSize = readPragmaNumber(this.#database, "PRAGMA page_size");
    return pageCount * pageSize;
  }

  /** Returns the latest local commit position that an object output can reveal. */
  get committedStoragePosition(): number {
    this.#requireStorageAccess();
    return this.#committedStoragePosition;
  }

  /** Proves the requested object storage position durable before external output is released. */
  ensureDurableStoragePosition(requiredPosition: number): void {
    this.#requireStorageAccess();
    if (this.#transaction) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_OUTPUT_DURING_TRANSACTION");
    }
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
    this.inputGate.close();
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
      this.#requireStorageAccess();
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

  #ownedTransaction(): ObjectDatabaseTransaction | null {
    const context = this.#transactionContext.getStore();
    if (context) {
      return context;
    }
    const transaction = this.#transaction;
    return transaction && transaction.owner === this.inputGate.operationOwner ? transaction : null;
  }

  #requireStorageAccess(): void {
    this.#requireUsable();
    const context = this.#ownedTransaction();
    if (context && !context.active) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_TRANSACTION_CLOSED");
    }
    if (context?.rolledBack) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_TRANSACTION_ROLLED_BACK");
    }
    // Synchronous SQL cannot wait. Already-admitted handlers fail closed instead of joining
    // another handler's transaction; asynchronous storage and new event admission can queue.
    if (this.#transaction && context !== this.#transaction) {
      throw new Error("NODE_RUNTIME_OBJECT_DATABASE_TRANSACTION_BUSY");
    }
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
