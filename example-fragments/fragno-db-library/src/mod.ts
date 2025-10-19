import { createFragnoDatabase } from "@fragno-dev/db";
import type { AbstractQuery, TableToInsertValues } from "@fragno-dev/db/query";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export const commentSchema = schema((s) => {
  return s
    .addTable("comment", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("createdAt", column("timestamp").defaultTo$("now")) // FIXME: Should support database time
        .addColumn("postReference", column("string")) // FIXME: Support external references
        .addColumn("userReference", column("string"))
        .addColumn("parentId", referenceColumn().nullable())
        .createIndex("idx_comment_post", ["postReference"]);
    })
    .addReference("parent", {
      type: "one",
      from: { table: "comment", column: "parentId" },
      to: { table: "comment", column: "id" },
    });
});

export const fragnoDatabaseLibrary = createFragnoDatabase({
  namespace: "fragno-db-comment-library",
  schema: commentSchema,
});

export function createFragnoDatabaseLibrary(orm: AbstractQuery<typeof commentSchema>) {
  const internal = {
    createComment: (comment: TableToInsertValues<typeof commentSchema.tables.comment>) => {
      return orm.create("comment", comment);
    },
    getComments: (postReference: string) => {
      return orm.find("comment", (b) =>
        b.whereIndex("idx_comment_post", (eb) => eb("postReference", "=", postReference)),
      );
    },
  };

  return {
    createComment: async (
      comment: Prettify<TableToInsertValues<typeof commentSchema.tables.comment>>,
    ) => {
      const id = await internal.createComment(comment);
      return {
        ...comment,
        id: id.toJSON(),
      };
    },
    getComments: (postReference: string) => {
      return internal.getComments(postReference);
    },
  };
}
