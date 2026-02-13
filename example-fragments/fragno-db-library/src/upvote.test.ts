import { describe, expect, it } from "vitest";
import { buildDatabaseFragmentsTest } from "@fragno-dev/test";
import { instantiate } from "@fragno-dev/core";
import { ratingFragmentDef, ratingSyncCommands } from "./upvote";
import { upvoteSchema } from "./schema/upvote";

describe("rating-fragment sync commands", () => {
  it("should apply rating commands", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment("rating", instantiate(ratingFragmentDef).withConfig({}).withRoutes([]))
      .build();

    const command = ratingSyncCommands.getCommand("postRating");
    expect(command).toBeDefined();

    await test.inContext(async function () {
      await command?.handler({
        input: {
          reference: "post-1",
          rating: 1,
          ownerReference: "user-1",
        },
        ctx: { mode: "server" },
        tx: (options) => this.handlerTx(options),
      });
    });

    const total = await fragments.rating.fragment.callServices(() =>
      fragments.rating.services.getRating("post-1"),
    );
    expect(total).toBe(1);

    const upvotes = await test.inContext(function () {
      return this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(upvoteSchema).find("upvote", (b) =>
            b.whereIndex("idx_upvote_reference", (eb) => eb("reference", "=", "post-1")),
          ),
        )
        .transformRetrieve(([rows]) => rows)
        .execute();
    });

    expect(upvotes).toHaveLength(1);
    expect(upvotes[0]).toMatchObject({
      reference: "post-1",
      ownerReference: "user-1",
      rating: 1,
    });

    await test.cleanup();
  });
});
