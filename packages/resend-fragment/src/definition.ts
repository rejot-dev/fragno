import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import { resendSchema } from "./schema";

export interface ResendFragmentConfig {
  // Add any server-side configuration here if needed
  onNoteCreated?: (
    idempotencyKey: string,
    payload: { noteId: string; userId: string },
  ) => Promise<void>;
}

export const resendFragmentDefinition = defineFragment<ResendFragmentConfig>("resend-fragment")
  .extend(withDatabase(resendSchema))
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
        note: Omit<TableToInsertValues<typeof resendSchema.tables.note>, "userId"> & {
          userId: string;
        },
      ) {
        return this.serviceTx(resendSchema)
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
        return this.serviceTx(resendSchema)
          .retrieve((uow) =>
            uow.find("note", (b) => b.whereIndex("primary").join((j) => j.author())),
          )
          .transformRetrieve(([notes]) => {
            return notes;
          })
          .build();
      },
      getNotesByUser: function (userEmail: string) {
        return this.serviceTx(resendSchema)
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
        return this.serviceTx(resendSchema)
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
