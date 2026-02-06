import type { TableToInsertValues } from "@fragno-dev/db/query";
import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { upvoteSchema } from "./schema/upvote";
import { z } from "zod";

export { upvoteSchema };

export interface RatingFragmentConfig {
  // Add any server-side configuration here if needed
}

export const ratingFragmentDef = defineFragment<RatingFragmentConfig>("fragno-db-rating")
  .extend(withDatabase(upvoteSchema))
  .withDependencies(({ db }) => {
    return {
      /**
       * @throws {Error} If the upvote fails due to a race condition or unique constraint violation.
       * @param upvote
       * @returns
       */
      postUpvote: async (upvote: TableToInsertValues<typeof upvoteSchema.tables.upvote>) => {
        const uow = db
          .createUnitOfWork()
          .find("upvote_total", (b) =>
            b.whereIndex("idx_upvote_total_reference", (eb) =>
              eb("reference", "=", upvote.reference),
            ),
          );
        const [upvoteTotals] = await uow.executeRetrieve();
        const upvoteTotal = upvoteTotals[0];

        if (upvoteTotal) {
          uow.update("upvote_total", upvoteTotal.id, (b) =>
            b.set({ total: upvoteTotal.total + 1 }).check(),
          );
        } else {
          uow.create("upvote_total", { reference: upvote.reference, total: 1 });
        }

        uow.create("upvote", upvote);

        // NOTE: In a race condition (check fails or unique constraint fails), this will throw.
        return uow.executeMutations();
      },
      getUpvoteTotal: (reference: string) => {
        return db.findFirst("upvote_total", (b) =>
          b.whereIndex("idx_upvote_total_reference", (eb) => eb("reference", "=", reference)),
        );
      },
    };
  })
  .providesBaseService(({ deps }) => ({
    postUpvote: (reference: string) => {
      return deps.postUpvote({
        reference: reference,
        ownerReference: crypto.randomUUID(),
        rating: 1,
      });
    },
    postDownvote: (reference: string) => {
      return deps.postUpvote({
        reference: reference,
        ownerReference: crypto.randomUUID(),
        rating: -1,
      });
    },
    getRating: async (reference: string) => {
      return (await deps.getUpvoteTotal(reference))?.total ?? 0;
    },
  }))
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
      handler: async ({ input }, { json }) => {
        const data = await input.valid();
        if (data.rating !== undefined && data.rating < 0) {
          await services.postDownvote(data.reference);
        } else {
          await services.postUpvote(data.reference);
        }
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
