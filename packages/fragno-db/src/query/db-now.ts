export type DbInterval = { tag: "db-interval"; ms: number };

export type DbIntervalInput =
  | number
  | {
      ms?: number;
      seconds?: number;
      minutes?: number;
      hours?: number;
      days?: number;
    };

export type DbNow = {
  tag: "db-now";
  offsetMs?: number;
  plus: (interval: DbInterval | DbIntervalInput) => DbNow;
};

const toIntervalMs = (input: DbInterval | DbIntervalInput): number => {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new Error("DB_INTERVAL_INVALID");
    }
    return input;
  }

  if (typeof input === "object" && input !== null && "tag" in input) {
    const tagged = input as DbInterval;
    if (tagged.tag === "db-interval") {
      if (!Number.isFinite(tagged.ms)) {
        throw new Error("DB_INTERVAL_INVALID");
      }
      return tagged.ms;
    }
    throw new Error("DB_INTERVAL_INVALID");
  }

  const interval = input as Exclude<DbIntervalInput, number>;
  const totalMs =
    (interval.ms ?? 0) +
    (interval.seconds ?? 0) * 1000 +
    (interval.minutes ?? 0) * 60_000 +
    (interval.hours ?? 0) * 3_600_000 +
    (interval.days ?? 0) * 86_400_000;

  if (!Number.isFinite(totalMs)) {
    throw new Error("DB_INTERVAL_INVALID");
  }

  return totalMs;
};

const createDbNow = (offsetMs = 0): DbNow => ({
  tag: "db-now",
  offsetMs,
  plus: (interval) => createDbNow(offsetMs + toIntervalMs(interval)),
});

export const dbNow = (): DbNow => createDbNow(0);

export const isDbNow = (value: unknown): value is DbNow =>
  typeof value === "object" && value !== null && (value as { tag?: string }).tag === "db-now";

export const getDbNowOffsetMs = (value: DbNow): number =>
  typeof value.offsetMs === "number" ? value.offsetMs : 0;

export const dbInterval = (input: DbIntervalInput): DbInterval => ({
  tag: "db-interval",
  ms: toIntervalMs(input),
});

export const isDbInterval = (value: unknown): value is DbInterval =>
  typeof value === "object" && value !== null && (value as { tag?: string }).tag === "db-interval";
