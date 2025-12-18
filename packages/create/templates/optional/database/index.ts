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
  onNoteCreated?: (nonce: string, payload: { noteId: string; userId: string }) => Promise<void>;
}

const exampleFragmentDefinition = defineFragment<ExampleConfig>("example-fragment")
  .extend(withDatabase(noteSchema))
  .provideHooks(({ defineHook, config }) => ({
    onNoteCreated: defineHook(async function (payload: { noteId: string; userId: string }) {
      // Hook runs after transaction commits, with retries on failure
      // Use this.nonce for idempotency (available via this context)
      await config.onNoteCreated?.(this.nonce, payload);
    }),
  }))
  .providesBaseService(({ defineService }) => {
    return defineService({
      createNote: async function (
        note: Omit<TableToInsertValues<typeof noteSchema.tables.note>, "userId"> & {
          userId: string;
        },
      ) {
        const uow = this.uow(noteSchema);

        // Find user first to get FragnoId for reference
        const userUow = uow.findFirst("user", (b) =>
          b.whereIndex("idx_user_email", (eb) => eb("email", "=", note.userId)),
        );
        const [user] = await userUow.retrievalPhase;

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

        // Wait for handler to execute mutation phase
        await uow.mutationPhase;

        return {
          id: noteId.valueOf(),
          content: note.content,
          userId: user.id.valueOf(),
          createdAt: new Date(),
        };
      },
      getNotes: async function () {
        const uow = this.uow(noteSchema).find("note", (b) =>
          b.whereIndex("primary").join((j) => j.author()),
        );
        const [notes] = await uow.retrievalPhase;
        return notes;
      },
      getNotesByUser: async function (userEmail: string) {
        const uow = this.uow(noteSchema);

        // First find the user by email
        const userUow = uow.findFirst("user", (b) =>
          b.whereIndex("idx_user_email", (eb) => eb("email", "=", userEmail)),
        );
        const [user] = await userUow.retrievalPhase;

        if (!user) {
          return [];
        }

        // Then find notes by the user's FragnoId
        // Note: userId is a reference column, FragnoId works directly in whereIndex
        const notesUow = uow.find("note", (b) =>
          b.whereIndex("idx_note_user", (eb) => eb("userId", "=", user.id)).join((j) => j.author()),
        );
        const [notes] = await notesUow.retrievalPhase;
        return notes;
      },
      updateNote: async function (noteId: string, content: string) {
        const uow = this.uow(noteSchema);

        // Find note first to get FragnoId for optimistic concurrency control
        // Join with author to get user information
        const noteUow = uow.findFirst("note", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", noteId)).join((j) => j.author()),
        );
        const [note] = await noteUow.retrievalPhase;

        if (!note) {
          throw new Error("Note not found");
        }

        // Update with optimistic concurrency control (.check())
        uow.update("note", note.id, (b) => b.set({ content }).check());

        // Wait for handler to execute mutation phase
        // On optimistic conflict, handler will retry the whole transaction
        await uow.mutationPhase;

        if (!note.author) {
          throw new Error("Note author not found");
        }

        return {
          id: note.id.valueOf(),
          content,
          userId: note.author.id.valueOf(),
          createdAt: note.createdAt,
        };
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

          const result = await this.uow(async ({ executeRetrieve }) => {
            const notesPromise = userEmail
              ? services.getNotesByUser(userEmail)
              : services.getNotes();

            // Execute all reads scheduled by services
            await executeRetrieve();

            return notesPromise;
          });

          const notes = await result;

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

          // Handler controls transaction execution with retry policy
          const result = await this.uow(
            async ({ executeMutate }) => {
              const notePromise = services.createNote({ content, userId: userEmail });

              // Execute retrieval (if needed) and mutation atomically
              // On optimistic conflict, this whole callback retries
              await executeMutate();

              return notePromise;
            },
            {
              // Retry policy for optimistic concurrency conflicts
              retryPolicy: new ExponentialBackoffRetryPolicy({
                maxRetries: 5,
                initialDelayMs: 10,
                maxDelayMs: 250,
              }),
            },
          );

          const note = await result;
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

          // Handler controls transaction with optimistic concurrency control
          const result = await this.uow(
            async ({ executeMutate }) => {
              const notePromise = services.updateNote(noteId, content);

              // Execute with optimistic concurrency control
              // If note was modified, whole transaction retries
              await executeMutate();

              return notePromise;
            },
            {
              retryPolicy: new ExponentialBackoffRetryPolicy({
                maxRetries: 5,
                initialDelayMs: 10,
                maxDelayMs: 250,
              }),
            },
          );

          const note = await result;
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
