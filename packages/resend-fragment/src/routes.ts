import { defineRoutes } from "@fragno-dev/core";
import { ExponentialBackoffRetryPolicy } from "@fragno-dev/db";
import { z } from "zod";
import { resendFragmentDefinition } from "./definition";

export const resendRoutesFactory = defineRoutes(resendFragmentDefinition).create(
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
