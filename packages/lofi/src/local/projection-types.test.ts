import { describe, expectTypeOf, it } from "vitest";

import { column, FragnoId, idColumn, schema } from "@fragno-dev/db/schema";

import { defineLocalProjection } from "./projection";

const appSchema = schema("app", (s) =>
  s.addTable("users", (t) => t.addColumn("id", idColumn()).addColumn("name", column("string"))),
);

const localSchema = schema("local_user_view", (s) =>
  s.addTable("user_cards", (t) =>
    t.addColumn("id", idColumn()).addColumn("displayName", column("string")),
  ),
);

describe("local projection types", () => {
  it("narrows retrieved to the non-skipped retrieve result", () => {
    defineLocalProjection({
      retrieve: ({ mutations, match, read }) => {
        const mutation = mutations
          .map((candidate) => match.one(candidate, appSchema, "users", ["create", "update"]))
          .find((candidate) => candidate !== undefined);
        if (!mutation) {
          return undefined;
        }
        return { existing: read.get(localSchema, "user_cards", mutation.externalId) };
      },
      mutate: ({ retrieved }) => {
        expectTypeOf(retrieved).toEqualTypeOf<{
          readonly existing: { id: FragnoId; displayName: string } | undefined;
        }>();

        // @ts-expect-error mutate is not called for skipped retrieve results.
        const skipped: undefined = retrieved;
        expectTypeOf(skipped).toEqualTypeOf<undefined>();
      },
    });
  });

  it("narrows match.all results", () => {
    defineLocalProjection({
      mutate: ({ match }) => {
        const mutations = match.all(appSchema, "users", ["create", "update"]);
        const first = mutations[0];
        if (first?.op === "create") {
          expectTypeOf(first.values.name).toEqualTypeOf<string>();
          // @ts-expect-error create mutations do not expose update sets.
          void first.set;
        }
        if (first?.op === "update") {
          expectTypeOf(first.set.name).toEqualTypeOf<string | undefined>();
          // @ts-expect-error update mutations do not expose create values.
          void first.values;
        }
      },
    });
  });

  it("pairs read.each items with typed local rows", () => {
    defineLocalProjection({
      retrieve: ({ match, read }) =>
        read
          .each(match.all(appSchema, "users", ["create", "update"]))
          .get(localSchema, "user_cards", (mutation) => mutation.externalId),
      mutate: ({ retrieved }) => {
        const first = retrieved[0];
        if (!first) {
          return;
        }
        expectTypeOf(first.item.externalId).toEqualTypeOf<string>();
        expectTypeOf(first.row).toEqualTypeOf<{ id: FragnoId; displayName: string } | undefined>();
      },
    });
  });

  it("uses undefined retrieved when no retrieve phase is declared", () => {
    defineLocalProjection({
      mutate: ({ retrieved }) => {
        expectTypeOf(retrieved).toEqualTypeOf<undefined>();
      },
    });
  });

  it("keeps null as a runnable retrieve result", () => {
    defineLocalProjection({
      retrieve: () => null as null | undefined,
      mutate: ({ retrieved }) => {
        expectTypeOf(retrieved).toEqualTypeOf<null>();
      },
    });
  });
});
