export type SyncCommandPlan = {
  readKeys: Array<{ shard: string | null; schema: string; table: string; externalId: string }>;
  writeKeys: Array<{ shard: string | null; schema: string; table: string; externalId: string }>;
  readScopes: Array<{
    shard: string | null;
    schema: string;
    table: string;
    indexName: string;
  }>;
};
