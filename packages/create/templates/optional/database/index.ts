import {
  defineRoute,
  defineRoutes,
  createFragment,
  type FragnoPublicClientConfig,
} from "@fragno-dev/core";
import { createClientBuilder } from "@fragno-dev/core/client";
import {
  defineFragmentWithDatabase,
  type FragnoPublicConfigWithDatabase,
} from "@fragno-dev/db/fragment";
import type { AbstractQuery, TableToInsertValues } from "@fragno-dev/db/query";
import { noteSchema } from "./schema";

// NOTE: We use zod here for defining schemas, but any StandardSchema library can be used!
//       For a complete list see:
// https://github.com/standard-schema/standard-schema#what-schema-libraries-implement-the-spec
import { z } from "zod";

export interface ExampleConfig {
  // Add any server-side configuration here if needed
}

type ExampleServices = {
  createNote: (note: TableToInsertValues<typeof noteSchema.tables.note>) => Promise<{
    id: string;
    content: string;
    userId: string;
    createdAt: Date;
  }>;
  getNotes: () => Promise<
    Array<{
      id: string;
      content: string;
      userId: string;
      createdAt: Date;
    }>
  >;
  getNotesByUser: (userId: string) => Promise<
    Array<{
      id: string;
      content: string;
      userId: string;
      createdAt: Date;
    }>
  >;
};

type ExampleDeps = {
  orm: AbstractQuery<typeof noteSchema>;
};

const exampleRoutesFactory = defineRoutes<ExampleConfig, ExampleDeps, ExampleServices>().create(
  ({ services }) => {
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
            return json(notes);
          }

          const notes = await services.getNotes();
          return json(notes);
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

const exampleFragmentDefinition = defineFragmentWithDatabase<ExampleConfig>("example-fragment")
  .withDatabase(noteSchema)
  .withServices(({ orm }) => {
    return {
      createNote: async (note: TableToInsertValues<typeof noteSchema.tables.note>) => {
        const id = await orm.create("note", note);
        return {
          ...note,
          id: id.toJSON(),
          createdAt: note.createdAt ?? new Date(),
        };
      },
      getNotes: () => {
        return orm.find("note", (b) => b);
      },
      getNotesByUser: (userId: string) => {
        return orm.find("note", (b) =>
          b.whereIndex("idx_note_user", (eb) => eb("userId", "=", userId)),
        );
      },
    };
  });

export function createExampleFragment(
  config: ExampleConfig = {},
  fragnoConfig: FragnoPublicConfigWithDatabase,
) {
  return createFragment(exampleFragmentDefinition, config, [exampleRoutesFactory], fragnoConfig);
}

export function createExampleFragmentClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(exampleFragmentDefinition, fragnoConfig, [exampleRoutesFactory]);

  return {
    useNotes: b.createHook("/notes"),
    useCreateNote: b.createMutator("POST", "/notes"),
  };
}
export type { FragnoRouteConfig } from "@fragno-dev/core/api";
