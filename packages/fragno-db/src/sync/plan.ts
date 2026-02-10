export type SyncCommandPlan = {
  readKeys: Array<{ schema: string; table: string; externalId: string }>;
  writeKeys: Array<{ schema: string; table: string; externalId: string }>;
  readScopes: Array<{
    schema: string;
    table: string;
    indexName: string;
  }>;
};
