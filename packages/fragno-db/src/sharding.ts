export type ShardScope = "scoped" | "global";

export type ShardingStrategy = { mode: "row" } | { mode: "adapter"; identifier: string };
