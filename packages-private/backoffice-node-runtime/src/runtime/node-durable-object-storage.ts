export type NodeDurableObjectSqlValue = ArrayBuffer | Uint8Array | string | number | bigint | null;

/** Iterates one synchronous Durable Object SQL result inside the object worker. */
export type NodeDurableObjectSqlCursor<TRow extends Record<string, unknown>> =
  IterableIterator<TRow> & {
    readonly columnNames: string[];
    readonly rowsRead: number;
    readonly rowsWritten: number;
    toArray(): TRow[];
    one(): TRow;
    raw<TValues extends NodeDurableObjectSqlValue[]>(): IterableIterator<TValues>;
  };

/** Executes object-scoped SQL; transactions belong to storage and Graft pushes remain runtime-owned. */
export type NodeDurableObjectSqlStorage = {
  exec<TRow extends Record<string, unknown>>(
    query: string,
    ...bindings: NodeDurableObjectSqlValue[]
  ): NodeDurableObjectSqlCursor<TRow>;
  readonly databaseSize: number;
};

export type NodeDurableObjectStorageListOptions = {
  prefix?: string;
};

/** A callback-scoped storage handle; rollback cancels the transaction and closes further access. */
export type NodeDurableObjectTransaction = Pick<
  NodeDurableObjectStorage,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm" | "deleteAlarm"
> & {
  rollback(): void;
};

/** Storage operations used by Backoffice objects, with SQL and KV on one transactional connection. */
export type NodeDurableObjectStorage = {
  get<TValue = unknown>(key: string): Promise<TValue | undefined>;
  get<TValue = unknown>(keys: string[]): Promise<Map<string, TValue>>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<TValue = unknown>(
    options?: NodeDurableObjectStorageListOptions,
  ): Promise<Map<string, TValue>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  readonly sql: NodeDurableObjectSqlStorage;
  transaction<TResult>(
    callback: (transaction: NodeDurableObjectTransaction) => Promise<TResult>,
  ): Promise<TResult>;
  transactionSync<TResult>(callback: () => TResult): TResult;
};
