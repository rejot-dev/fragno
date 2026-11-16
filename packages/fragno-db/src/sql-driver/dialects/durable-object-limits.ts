// See https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits.

/** The most parameters Durable Object SQLite binds in one statement. */
export const DURABLE_OBJECT_MAX_BOUND_PARAMETERS = 100;

/** The most bytes Durable Object SQLite holds in one string or BLOB, bound ones included. */
export const DURABLE_OBJECT_MAX_VALUE_BYTES = 2_000_000;
