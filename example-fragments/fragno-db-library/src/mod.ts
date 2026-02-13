import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { z } from "zod";
import { defineSyncCommands } from "@fragno-dev/db";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { withDatabase, type DatabaseServiceContext } from "@fragno-dev/db";
import { commentSchema } from "./schema/comment";

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export { commentSchema };

export type CommentSyncCommandInput = {
  title: string;
  content: string;
  postReference: string;
  userReference: string;
  parentId?: string | null;
};

export const commentSyncCommands = defineSyncCommands({ schema: commentSchema }).create(
  ({ defineCommand }) => [
    defineCommand({
      name: "createComment",
      handler: async ({ input, tx }) => {
        const payload = input as CommentSyncCommandInput;
        await tx()
          .mutate(({ forSchema }) => {
            forSchema(commentSchema).create("comment", {
              title: payload.title,
              content: payload.content,
              postReference: payload.postReference,
              userReference: payload.userReference,
              parentId: payload.parentId ?? null,
            });
          })
          .execute();
      },
    }),
  ],
);

export interface CommentFragmentConfig {
  // Add any server-side configuration here if needed
}

export const commentFragmentDef = defineFragment<CommentFragmentConfig>("fragno-db-comment")
  .extend(withDatabase(commentSchema))
  .withSyncCommands(commentSyncCommands)
  .providesBaseService(({ defineService }) => createFragnoDatabaseLibrary(defineService))
  .build();

export function createFragnoDatabaseLibrary(
  defineService: <T>(svc: T & ThisType<DatabaseServiceContext<{}>>) => T,
) {
  return defineService({
    createComment(comment: Prettify<TableToInsertValues<typeof commentSchema.tables.comment>>) {
      return this.serviceTx(commentSchema)
        .mutate(({ uow }) => uow.create("comment", comment))
        .transform(({ mutateResult }) => ({
          ...comment,
          id: mutateResult.valueOf(),
        }))
        .build();
    },
    getComments(postReference: string) {
      return this.serviceTx(commentSchema)
        .retrieve((uow) =>
          uow.find("comment", (b) =>
            b.whereIndex("idx_comment_post", (eb) => eb("postReference", "=", postReference)),
          ),
        )
        .transformRetrieve(([comments]) => comments.map((c) => ({ ...c, id: c.id.valueOf() })))
        .build();
    },
  });
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
          const comments = await this.handlerTx()
            .withServiceCalls(() => [services.getComments(postReference)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
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
        handler: async function ({ input }, { json }) {
          const data = await input.valid();
          const comment = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.createComment({
                    ...data,
                    parentId: data.parentId || null,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
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
