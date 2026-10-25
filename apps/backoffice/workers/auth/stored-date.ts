/** How SQLite returns a Better Auth date column: a Date through its adapter, raw through Kysely. */
export type StoredDate = Date | string | number;

/** Numbers below ten billion are seconds, as Better Auth wrote them; larger ones are milliseconds. */
export const toDate = (value: StoredDate): Date => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value < 10_000_000_000 ? value * 1_000 : value);
  }
  return new Date(value);
};
