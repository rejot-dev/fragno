export type ShardScope = "scoped" | "global";

export type ShardingStrategy = { mode: "row" } | { mode: "adapter"; identifier: string };

/**
 * Internal sentinel used to represent the global/unscoped shard in storage.
 * This ensures _shard is never NULL, so unique constraints behave consistently.
 */
export const GLOBAL_SHARD_SENTINEL = "__fragno_global__";

export const resolveShardValue = (shard: string | null): string => shard ?? GLOBAL_SHARD_SENTINEL;
