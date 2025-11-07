import { Kysely } from "kysely";
import type { Dialect } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type { KyselyDatabase } from "./kysely-types";

export const pgFolder = "./.data/comments.pglite" as const;

const created = await KyselyPGlite.create(pgFolder);
export const dialect: Dialect = created.dialect;

export const db = new Kysely<KyselyDatabase>({
  dialect: dialect,
});
