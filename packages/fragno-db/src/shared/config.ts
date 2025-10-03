import type { Kysely } from "kysely";
import type { SQLProvider } from "./providers";
import type { AnySchema } from "../schema/create";

export interface LibraryConfig<TSchemas extends AnySchema[] = AnySchema[]> {
  namespace: string;

  /**
   * different versions of schemas (sorted in ascending order)
   */
  schemas: TSchemas;
}

export interface KyselyConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>;
  provider: SQLProvider;
}
