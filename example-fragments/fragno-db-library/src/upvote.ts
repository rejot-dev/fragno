import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { defineSyncCommands, withDatabase } from "@fragno-dev/db";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { upvoteSchema } from "./schema/upvote";
import { z } from "zod";

export { upvoteSchema };

export type RatingSyncCommandInput = {
  reference: string;
  rating?: number;
  ownerReference?: string | null;
  note?: string | null;
};

export const ratingSyncCommands = defineSyncCommands({ schema: upvoteSchema }).create(
  ({ defineCommand }) => [
    defineCommand({
      name: "postRating",
      handler: async ({ input, tx }) => {
        const payload = input as RatingSyncCommandInput;
        const rating = payload.rating ?? 1;
        await tx()
          .retrieve(({ forSchema }) =>
            forSchema(upvoteSchema).findFirst("upvote_total", (b) =>
              b.whereIndex("idx_upvote_total_reference", (eb) =>
                eb("reference", "=", payload.reference),
              ),
            ),
          )
          .transformRetrieve(([result]) => result ?? null)
          .mutate(({ forSchema, retrieveResult }) => {
            if (retrieveResult) {
              forSchema(upvoteSchema).update("upvote_total", retrieveResult.id, (b) =>
                b.set({ total: retrieveResult.total + rating }).check(),
              );
            } else {
              forSchema(upvoteSchema).create("upvote_total", {
                reference: payload.reference,
                total: rating,
              });
            }

            forSchema(upvoteSchema).create("upvote", {
              reference: payload.reference,
              ownerReference: payload.ownerReference ?? null,
              rating,
              note: payload.note ?? null,
            });
          })
          .execute();
      },
    }),
  ],
);

export interface RatingFragmentConfig {
  // Add any server-side configuration here if needed
}

export const ratingFragmentDef = defineFragment<RatingFragmentConfig>("fragno-db-rating")
  .extend(withDatabase(upvoteSchema))
  .withSyncCommands(ratingSyncCommands)
  .providesBaseService(({ defineService }) =>
    defineService({
      /**
       * @throws {Error} If the upvote fails due to a race condition or unique constraint violation.
       */
      postUpvote(reference: string) {
        return this.serviceTx(upvoteSchema)
          .retrieve((uow) =>
            uow.findFirst("upvote_total", (b) =>
              b.whereIndex("idx_upvote_total_reference", (eb) => eb("reference", "=", reference)),
            ),
          )
          .transformRetrieve(([result]) => result ?? null)
          .mutate(({ uow, retrieveResult }) => {
            if (retrieveResult) {
              uow.update("upvote_total", retrieveResult.id, (b) =>
                b.set({ total: retrieveResult.total + 1 }).check(),
              );
            } else {
              uow.create("upvote_total", { reference, total: 1 });
            }

            uow.create("upvote", {
              reference,
              ownerReference: crypto.randomUUID(),
              rating: 1,
            });

            return { success: true };
          })
          .build();
      },
      postDownvote(reference: string) {
        return this.serviceTx(upvoteSchema)
          .retrieve((uow) =>
            uow.findFirst("upvote_total", (b) =>
              b.whereIndex("idx_upvote_total_reference", (eb) => eb("reference", "=", reference)),
            ),
          )
          .transformRetrieve(([result]) => result ?? null)
          .mutate(({ uow, retrieveResult }) => {
            if (retrieveResult) {
              uow.update("upvote_total", retrieveResult.id, (b) =>
                b.set({ total: retrieveResult.total - 1 }).check(),
              );
            } else {
              uow.create("upvote_total", { reference, total: -1 });
            }

            uow.create("upvote", {
              reference,
              ownerReference: crypto.randomUUID(),
              rating: -1,
            });

            return { success: true };
          })
          .build();
      },
      postRating(reference: string, rating: number) {
        return this.serviceTx(upvoteSchema)
          .retrieve((uow) =>
            uow.findFirst("upvote_total", (b) =>
              b.whereIndex("idx_upvote_total_reference", (eb) => eb("reference", "=", reference)),
            ),
          )
          .transformRetrieve(([result]) => result ?? null)
          .mutate(({ uow, retrieveResult }) => {
            if (retrieveResult) {
              uow.update("upvote_total", retrieveResult.id, (b) =>
                b.set({ total: retrieveResult.total + rating }).check(),
              );
            } else {
              uow.create("upvote_total", { reference, total: rating });
            }

            uow.create("upvote", {
              reference,
              ownerReference: crypto.randomUUID(),
              rating,
            });

            return { success: true };
          })
          .build();
      },
      getRating(reference: string) {
        return this.serviceTx(upvoteSchema)
          .retrieve((uow) =>
            uow.findFirst("upvote_total", (b) =>
              b.whereIndex("idx_upvote_total_reference", (eb) => eb("reference", "=", reference)),
            ),
          )
          .transformRetrieve(([result]) => result?.total ?? 0)
          .build();
      },
    }),
  )
  .build();

const ratingRoutesFactory = defineRoutes(ratingFragmentDef).create(({ services, defineRoute }) => {
  return [
    defineRoute({
      method: "POST",
      path: "/upvotes",
      inputSchema: z.object({
        reference: z.string(),
        rating: z.number().int().optional(),
      }),
      outputSchema: z.any(),
      errorCodes: ["CREATION_FAILED", "INVALID_INPUT"] as const,
      handler: async function ({ input }, { json }) {
        const data = await input.valid();
        const rating = data.rating ?? 1;
        await this.handlerTx()
          .withServiceCalls(() => [services.postRating(data.reference, rating)] as const)
          .execute();
        return json({ ok: true });
      },
    }),
  ];
});

const routes = [ratingRoutesFactory] as const;

export function createRatingFragment(
  config: RatingFragmentConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(ratingFragmentDef)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}
