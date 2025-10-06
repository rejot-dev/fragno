import { createFragnoDatabase } from "@fragno-dev/db";
import type { AbstractQuery } from "@fragno-dev/db/query";
import { column, idColumn, schema } from "@fragno-dev/db/schema";

export const userSchema = schema((s) => {
  return s.addTable("posts", (t) => {
    return t
      .addColumn("id", idColumn().defaultTo("auto"))
      .addColumn("title", column("string"))
      .addColumn("content", column("string"));
  });
});

export const fragnoDatabaseLibrary = createFragnoDatabase({
  namespace: "fragno-db-test-library",
  schema: userSchema,
});

export function createFragnoDatabaseLibrary(orm: AbstractQuery<typeof userSchema>) {
  return {
    createPost: (post: { title: string; content: string }) => {
      return orm.create("posts", post);
    },
  };
}
