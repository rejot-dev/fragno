export type DbNow = { tag: "db-now" };

export const dbNow = (): DbNow => ({ tag: "db-now" });

export const isDbNow = (value: unknown): value is DbNow =>
  typeof value === "object" && value !== null && (value as { tag?: string }).tag === "db-now";
