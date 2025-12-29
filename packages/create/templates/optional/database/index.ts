import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import {
  withDatabase,
  type FragnoPublicConfigWithDatabase,
  ExponentialBackoffRetryPolicy,
} from "@fragno-dev/db";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import { noteSchema } from "./schema";

// NOTE: We use zod here for defining schemas, but any StandardSchema library can be used!
//       For a complete list see:
// https://github.com/standard-schema/standard-schema#what-schema-libraries-implement-the-spec
import { z } from "zod";

export interface ExampleConfig {
  // Add any server-side configuration here if needed
  onNoteCreated?: (
    idempotencyKey: string,
    payload: { noteId: string; userId: string },
  ) => Promise<void>;
}

const exampleFragmentDefinition = defineFragment<ExampleConfig>("example-fragment")
  .extend(withDatabase(noteSchema))
  .provideHooks(({ defineHook, config }) => ({
    onNoteCreated: defineHook(async function (payload: { noteId: string; userId: string }) {
      // Hook runs after transaction commits, with retries on failure
      // Use this.idempotencyKey for idempotency (e.g., deduplicating webhook calls)
      await config.onNoteCreated?.(this.idempotencyKey, payload);
    }),
  }))
  .providesBaseService(({ defineService }) => {
    return defineService({
      createNote: function (
        note: Omit<TableToInsertValues<typeof noteSchema.tables.note>, "userId"> & {
          userId: string;
        },
      ) {
        return this.serviceTx(noteSchema)
          .retrieve((uow) =>
            uow.findFirst("user", (b) =>
              b.whereIndex("idx_user_email", (eb) => eb("email", "=", note.userId)),
            ),
          )
          .mutate(({ uow, retrieveResult: [user] }) => {
            if (!user) {
              throw new Error("User not found");
            }

            // Create note with reference to user
            const noteId = uow.create("note", {
              content: note.content,
              userId: user.id,
            });

            // Trigger durable hook (recorded in transaction, executed after commit)
            uow.triggerHook("onNoteCreated", {
              noteId: noteId.valueOf(),
              userId: user.id.valueOf(),
            });

            return {
              id: noteId.valueOf(),
              content: note.content,
              userId: user.id.valueOf(),
              createdAt: new Date(),
            };
          })
          .build();
      },
      getNotes: function () {
        return this.serviceTx(noteSchema)
          .retrieve((uow) =>
            uow.find("note", (b) => b.whereIndex("primary").join((j) => j.author())),
          )
          .transformRetrieve(([notes]) => {
            return notes;
          })
          .build();
      },
      getNotesByUser: function (userEmail: string) {
        return this.serviceTx(noteSchema)
          .retrieve((uow) =>
            uow
              .findFirst("user", (b) =>
                b.whereIndex("idx_user_email", (eb) => eb("email", "=", userEmail)),
              )
              .find("note", (b) => b.whereIndex("primary").join((j) => j.author())),
          )
          .transformRetrieve(([user, allNotes]) => {
            if (!user) {
              return [];
            }
            // Filter notes that belong to this user
            return allNotes.filter((note) => note.author?.id.toString() === user.id.toString());
          })
          .build();
      },
      updateNote: function (noteId: string, content: string) {
        return this.serviceTx(noteSchema)
          .retrieve((uow) =>
            uow.findFirst("note", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", noteId)).join((j) => j.author()),
            ),
          )
          .mutate(({ uow, retrieveResult: [note] }) => {
            if (!note) {
              throw new Error("Note not found");
            }

            if (!note.author) {
              throw new Error("Note author not found");
            }

            // Update with optimistic concurrency control (.check())
            uow.update("note", note.id, (b) => b.set({ content }).check());

            return {
              id: note.id.valueOf(),
              content,
              userId: note.author.id.valueOf(),
              createdAt: note.createdAt,
            };
          })
          .build();
      },
    });
  })
  .build();

const exampleRoutesFactory = defineRoutes(exampleFragmentDefinition).create(
  ({ services, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/notes",
        queryParameters: ["userId"],
        outputSchema: z.array(
          z.object({
            id: z.string(),
            content: z.string(),
            userId: z.string(),
            userName: z.string(),
            createdAt: z.date(),
          }),
        ),
        handler: async function ({ query }, { json }) {
          const userEmail = query.get("userId"); // Using userId param name for backward compatibility

          const [notes] = await this.handlerTx()
            .withServiceCalls(() => [
              userEmail ? services.getNotesByUser(userEmail) : services.getNotes(),
            ])
            .execute();

          return json(
            notes
              .filter((note) => note.author !== null)
              .map((note) => ({
                id: note.id.valueOf(),
                content: note.content,
                userId: note.author!.id.valueOf(),
                userName: note.author!.name,
                createdAt: note.createdAt,
              })),
          );
        },
      }),

      defineRoute({
        method: "POST",
        path: "/notes",
        inputSchema: z.object({ content: z.string(), userEmail: z.string() }),
        outputSchema: z.object({
          id: z.string(),
          content: z.string(),
          userId: z.string(),
          createdAt: z.date(),
        }),
        errorCodes: [],
        handler: async function ({ input }, { json }) {
          const { content, userEmail } = await input.valid();

          const [note] = await this.handlerTx({
            // Retry policy for optimistic concurrency conflicts
            retryPolicy: new ExponentialBackoffRetryPolicy({
              maxRetries: 5,
              initialDelayMs: 10,
              maxDelayMs: 250,
            }),
          })
            .withServiceCalls(() => [services.createNote({ content, userId: userEmail })])
            .execute();

          return json(note);
        },
      }),

      defineRoute({
        method: "PATCH",
        path: "/notes/:noteId",
        inputSchema: z.object({ content: z.string() }),
        outputSchema: z.object({
          id: z.string(),
          content: z.string(),
          userId: z.string(),
          createdAt: z.date(),
        }),
        errorCodes: [],
        handler: async function ({ input, pathParams }, { json }) {
          const { content } = await input.valid();
          const noteId = pathParams.noteId;

          const [note] = await this.handlerTx({
            retryPolicy: new ExponentialBackoffRetryPolicy({
              maxRetries: 5,
              initialDelayMs: 10,
              maxDelayMs: 250,
            }),
          })
            .withServiceCalls(() => [services.updateNote(noteId, content)])
            .execute();

          return json(note);
        },
      }),
    ];
  },
);

export function createExampleFragment(
  config: ExampleConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(exampleFragmentDefinition)
    .withConfig(config)
    .withRoutes([exampleRoutesFactory])
    .withOptions(options)
    .build();
}

export function createExampleFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(exampleFragmentDefinition, fragnoConfig, [exampleRoutesFactory]);

  return {
    useNotes: b.createHook("/notes"),
    useCreateNote: b.createMutator("POST", "/notes"),
  };
}
export type { FragnoRouteConfig } from "@fragno-dev/core";
