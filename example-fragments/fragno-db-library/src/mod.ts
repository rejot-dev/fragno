import { createFragment, defineRoutes, type FragnoPublicClientConfig } from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import { z } from "zod";
import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";
import {
  defineFragmentWithDatabase,
  type FragnoPublicConfigWithDatabase,
} from "@fragno-dev/db/fragment";
import type { AbstractQuery, TableToInsertValues } from "@fragno-dev/db/query";

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
        .addColumn(
          "createdAt",
          column("timestamp").defaultTo((b) => b.now()),
        )
        .addColumn("postReference", column("string")) // FIXME: Support external references
        .addColumn("userReference", column("string"))
        .addColumn("parentId", referenceColumn().nullable())
        .createIndex("idx_comment_post", ["postReference"]);
    })
    .addReference("parent", {
      type: "one",
      from: { table: "comment", column: "parentId" },
      to: { table: "comment", column: "id" },
    })
    .alterTable("comment", (t) => {
      return t.addColumn("rating", column("integer").defaultTo(0));
    });
});

export interface CommentFragmentConfig {
  // Add any server-side configuration here if needed
}

export const commentFragmentDef = defineFragmentWithDatabase<CommentFragmentConfig>(
  "fragno-db-comment",
)
  .withDatabase(commentSchema)
  .providesService(({ db }) => {
    return {
      ...createFragnoDatabaseLibrary(db),
    };
  });

export function createFragnoDatabaseLibrary(db: AbstractQuery<typeof commentSchema>) {
  const internal = {
    createComment: (comment: TableToInsertValues<typeof commentSchema.tables.comment>) => {
      return db.create("comment", comment);
    },
    getComments: (postReference: string) => {
      return db.find("comment", (b) =>
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
        id: id.valueOf(),
      };
    },
    getComments: async (postReference: string) => {
      const comments = await internal.getComments(postReference);
      return comments.map((c) => ({ ...c, id: c.id.valueOf() }));
    },
  };
}

const commentRoutesFactory = defineRoutes(commentFragmentDef).create(
  ({ services, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/comments",
        queryParameters: ["postReference"],
        outputSchema: z.array(z.any()),
        errorCodes: ["NOT_FOUND", "INVALID_INPUT"] as const,
        handler: async function ({ query }, { json }) {
          const uow = this.getUnitOfWork();
          console.log({ uow });

          const postReference = query.get("postReference");
          if (!postReference) {
            throw new Error("postReference is required");
          }
          const comments = await services.getComments(postReference);
          return json(comments);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/comments",
        inputSchema: z.object({
          title: z.string(),
          content: z.string(),
          postReference: z.string(),
          userReference: z.string(),
          parentId: z.string().optional(),
        }),
        outputSchema: z.any(),
        errorCodes: ["CREATION_FAILED", "INVALID_INPUT"] as const,
        handler: async ({ input }, { json }) => {
          const data = await input.valid();
          const comment = await services.createComment({
            ...data,
            parentId: data.parentId || null,
          });
          return json(comment);
        },
      }),
    ];
  },
);

const routes = [commentRoutesFactory] as const;

export function createCommentFragment(
  config: CommentFragmentConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return createFragment(commentFragmentDef, config, routes, options);
}

export function createCommentFragmentClient(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(commentFragmentDef, fragnoConfig, routes);

  return {
    useGetComments: b.createHook("/comments"),
    useCreateComment: b.createMutator("POST", "/comments"),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
