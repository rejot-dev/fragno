export const SHARD_COLUMN = "_shard";

export const stripShardField = (
  values?: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (!values || !(SHARD_COLUMN in values)) {
    return values;
  }
  const { _shard: _ignored, ...rest } = values;
  return rest;
};

export const shouldIgnoreSystemColumn = (columnName: string): boolean =>
  columnName === SHARD_COLUMN;
