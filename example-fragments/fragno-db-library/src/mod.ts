import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { z } from "zod";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { SimpleQueryInterface, TableToInsertValues } from "@fragno-dev/db/query";
import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { commentSchema } from "./schema/comment";

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export { commentSchema };

export interface CommentFragmentConfig {
  // Add any server-side configuration here if needed
}

export const commentFragmentDef = defineFragment<CommentFragmentConfig>("fragno-db-comment")
  .extend(withDatabase(commentSchema))
  .providesBaseService(({ deps }) => {
    return {
      ...createFragnoDatabaseLibrary(deps.db),
    };
  })
  .build();

export function createFragnoDatabaseLibrary(db: SimpleQueryInterface<typeof commentSchema>) {
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
  return instantiate(commentFragmentDef)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}

export function createCommentFragmentClient(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(commentFragmentDef, fragnoConfig, routes);

  return {
    useGetComments: b.createHook("/comments"),
    useCreateComment: b.createMutator("POST", "/comments"),
  };
}

export type { FragnoRouteConfig } from "@fragno-dev/core/api";
