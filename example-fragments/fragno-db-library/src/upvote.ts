import { createFragment } from "@fragno-dev/core";
import type { TableToInsertValues } from "@fragno-dev/db/query";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import {
  defineFragmentWithDatabase,
  type FragnoPublicConfigWithDatabase,
} from "@fragno-dev/db/fragment";

export const upvoteSchema = schema((s) => {
  return s
    .addTable("upvote", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("ownerReference", column("string").nullable())
        .addColumn("rating", column("integer"))
        .addColumn("createdAt", column("timestamp").defaultTo$("now"))
        .addColumn("note", column("string").nullable())
        .createIndex("idx_upvote_reference", ["reference", "ownerReference"]);
    })
    .addTable("upvote_total", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("total", column("integer").defaultTo(0))
        .createIndex("idx_upvote_total_reference", ["reference"], { unique: true });
    });
});

export interface RatingFragmentConfig {
  // Add any server-side configuration here if needed
}

const ratingFragmentDef = defineFragmentWithDatabase<RatingFragmentConfig>("fragno-db-rating")
  .withDatabase(upvoteSchema)
  .withDependencies(({ orm }) => {
    return {
      /**
       * @throws {Error} If the upvote fails due to a race condition or unique constraint violation.
       * @param upvote
       * @returns
       */
      postUpvote: async (upvote: TableToInsertValues<typeof upvoteSchema.tables.upvote>) => {
        const uow = orm
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
        return orm.findFirst("upvote_total", (b) =>
          b.whereIndex("idx_upvote_total_reference", (eb) => eb("reference", "=", reference)),
        );
      },
    };
  })
  .withServices(({ deps }) => {
    return {
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
    };
  });

export function createRatingFragment(
  config: RatingFragmentConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return createFragment(ratingFragmentDef, config, [], options);
}
