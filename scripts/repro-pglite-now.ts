import { PGlite } from "@electric-sql/pglite";

const toDate = (value: unknown): Date => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value);
  }
  throw new Error(`Unexpected timestamp value: ${String(value)}`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runPair = async (db: PGlite, label: string, sql: string) => {
  const r1 = await db.query(sql);
  await sleep(5);
  const r2 = await db.query(sql);

  const v1 = r1.rows[0]?.now;
  const v2 = r2.rows[0]?.now;

  const d1 = toDate(v1);
  const d2 = toDate(v2);

  const deltaMs = Math.abs(d2.getTime() - d1.getTime());

  console.log(`${label}:`);
  console.log(`  first:  ${d1.toISOString()}`);
  console.log(`  second: ${d2.toISOString()}`);
  console.log(`  delta:  ${deltaMs} ms`);
  console.log("-");
};

const main = async () => {
  const db = new PGlite();

  console.log("Transaction scope checks");
  await db.exec("BEGIN");
  await runPair(db, "CURRENT_TIMESTAMP (same tx)", "SELECT CURRENT_TIMESTAMP as now");
  await runPair(db, "transaction_timestamp() (same tx)", "SELECT transaction_timestamp() as now");
  await runPair(db, "now() (same tx)", "SELECT now() as now");
  await db.exec("COMMIT");

  console.log("Autocommit checks");
  await runPair(db, "CURRENT_TIMESTAMP (autocommit)", "SELECT CURRENT_TIMESTAMP as now");
  await runPair(
    db,
    "transaction_timestamp() (autocommit)",
    "SELECT transaction_timestamp() as now",
  );
  await runPair(db, "now() (autocommit)", "SELECT now() as now");
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
