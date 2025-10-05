import type { AnySchema } from "../schema/create";

export interface LibraryConfig<TSchemas extends AnySchema[] = AnySchema[]> {
  namespace: string;

  /**
   * different versions of schemas (sorted in ascending order)
   */
  schemas: TSchemas;
}
