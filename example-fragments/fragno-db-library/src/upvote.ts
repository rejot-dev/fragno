import type { TableToInsertValues } from "@fragno-dev/db/query";
import { defineFragment, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { upvoteSchema } from "./schema/upvote";

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

export function createRatingFragment(
  config: RatingFragmentConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(ratingFragmentDef)
    .withConfig(config)
    .withRoutes([])
    .withOptions(options)
    .build();
}
