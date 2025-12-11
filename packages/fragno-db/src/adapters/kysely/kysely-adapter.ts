import { type Kysely } from "kysely";
import type { SQLProvider } from "../../shared/providers";
import { type DatabaseAdapter } from "../adapters";
import { createTableNameMapper } from "../shared/table-name-mapper";
import {
  GenericSQLAdapter,
  type GenericSQLOptions,
  type UnitOfWorkConfig,
} from "../generic-sql/generic-sql-adapter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KyselyAny = Kysely<any>;

export interface KyselyConfig {
  db: KyselyAny | (() => KyselyAny | Promise<KyselyAny>);
  provider: SQLProvider;
}

export class KyselyAdapter extends GenericSQLAdapter implements DatabaseAdapter<UnitOfWorkConfig> {
  constructor(options: GenericSQLOptions) {
    super(options);
  }

  createTableNameMapper(namespace: string) {
    return createTableNameMapper(namespace);
  }
}
