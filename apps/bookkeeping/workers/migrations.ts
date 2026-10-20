/**
 * Applies the SQL migrations an object has not applied yet, in order; the stored version is the
 * number already applied. Each one commits atomically with its version, so a failed deploy never
 * half-applies a migration. Call it from the constructor's `blockConcurrencyWhile`.
 */
export function applyMigrations(ctx: DurableObjectState, migrations: readonly string[]): void {
  const applied = ctx.storage.kv.get<number>("schemaVersion") ?? 0;
  for (const [index, migration] of migrations.entries()) {
    if (index >= applied) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec(migration);
        ctx.storage.kv.put("schemaVersion", index + 1);
      });
    }
  }
}
