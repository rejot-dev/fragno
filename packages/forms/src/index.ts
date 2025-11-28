import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { createClientBuilder, type FragnoPublicClientConfig } from "@fragno-dev/core/client";
import { withDatabase, type FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import { noteSchema } from "./schema";

// NOTE: We use zod here for defining schemas, but any StandardSchema library can be used!
//       For a complete list see:
// https://github.com/standard-schema/standard-schema#what-schema-libraries-implement-the-spec
import { z } from "zod";

export interface ExampleConfig {
  // Add any server-side configuration here if needed
}

const exampleFragmentDefinition = defineFragment<ExampleConfig>("example-fragment")
  .extend(withDatabase(noteSchema))
  .providesBaseService(({ deps }) => {
    return {
      createNote: async (note: TableToInsertValues<typeof noteSchema.tables.note>) => {
        const id = await deps.db.create("note", note);
        return {
          ...note,
          id: id.valueOf(),
          createdAt: note.createdAt ?? new Date(),
        };
      },
      getNotes: () => {
        return deps.db.find("note", (b) => b);
      },
      getNotesByUser: (userId: string) => {
        return deps.db.find("note", (b) =>
          b.whereIndex("idx_note_user", (eb) => eb("userId", "=", userId)),
        );
      },
    };
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
            createdAt: z.date(),
          }),
        ),
        handler: async ({ query }, { json }) => {
          const userId = query.get("userId");

          if (userId) {
            const notes = await services.getNotesByUser(userId);
            return json(
              notes.map((note) => ({
                id: note.id.valueOf(),
                content: note.content,
                userId: note.userId,
                createdAt: note.createdAt,
              })),
            );
          }

          const notes = await services.getNotes();
          return json(
            notes.map((note) => ({
              id: note.id.valueOf(),
              content: note.content,
              userId: note.userId,
              createdAt: note.createdAt,
            })),
          );
        },
      }),

      defineRoute({
        method: "POST",
        path: "/notes",
        inputSchema: z.object({ content: z.string(), userId: z.string() }),
        outputSchema: z.object({
          id: z.string(),
          content: z.string(),
          userId: z.string(),
          createdAt: z.date(),
        }),
        errorCodes: [],
        handler: async ({ input }, { json }) => {
          const { content, userId } = await input.valid();

          const note = await services.createNote({ content, userId });
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
