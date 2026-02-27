import type { QueryPolicy } from "./unit-of-work";
import { resolveShardValue, type ShardScope, type ShardingStrategy } from "../../sharding";
import { SETTINGS_TABLE_NAME } from "../../fragments/internal-fragment.schema";
import type { AnyTable } from "../../schema/create";
import type { Condition } from "../condition-builder";

export type ShardPolicyOptions = {
  shardingStrategy?: ShardingStrategy;
  getShard: () => string | null;
  getShardScope: () => ShardScope;
};

const buildShardCondition = (table: AnyTable, shard: string | null): Condition => {
  const shardColumn = table.getColumnByName("_shard");
  if (!shardColumn) {
    throw new Error(`Missing _shard column on table "${table.name}".`);
  }
  return { type: "compare", a: shardColumn, operator: "=", b: resolveShardValue(shard) };
};

export const createShardQueryPolicy = (options: ShardPolicyOptions): QueryPolicy => {
  const shouldApplyShardFilter = () =>
    options.shardingStrategy?.mode === "row" && options.getShardScope() !== "global";

  return {
    name: "sharding",
    assertContext: () => {
      if (
        options.shardingStrategy?.mode === "adapter" &&
        options.getShardScope() !== "global" &&
        options.getShard() === null
      ) {
        throw new Error(
          'Shard must be set when shardingStrategy mode is "adapter" unless shardScope is "global".',
        );
      }
    },
    mutateCreate: (_ctx, values) => {
      if (Object.prototype.hasOwnProperty.call(values, "_shard")) {
        throw new Error("Cannot set _shard explicitly. It is managed by the shard context.");
      }
      return {
        ...values,
        _shard: resolveShardValue(options.getShard()),
      };
    },
    extraWhere: ({ table }) => {
      if (!shouldApplyShardFilter() || table.name === SETTINGS_TABLE_NAME) {
        return null;
      }
      return buildShardCondition(table, options.getShard());
    },
    extraJoinWhere: ({ table }) => {
      if (!shouldApplyShardFilter() || table.name === SETTINGS_TABLE_NAME) {
        return null;
      }
      return buildShardCondition(table, options.getShard());
    },
  };
};
