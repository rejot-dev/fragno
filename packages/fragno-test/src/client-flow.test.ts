import { describe, expect, it } from "vitest";

import { createClientBuilder } from "@fragno-dev/core/client";
import { useFragno } from "@fragno-dev/core/vanilla";
import { column, idColumn, schema } from "@fragno-dev/db/schema";
import { z } from "zod";

import { defineFragment, defineRoutes, instantiate } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { createFragmentTestClientConfig, waitForStore } from "./client-flow";
import { buildDatabaseFragmentsTest } from "./db-test";

const notesSchema = schema("client_flow", (s) =>
  s.addTable("notes", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("content", column("string"))
      .createIndex("idx_notes_all", ["id"]),
  ),
);

const notesFragmentDefinition = defineFragment("notes-fragment")
  .extend(withDatabase(notesSchema))
  .build();

const notesRoutes = defineRoutes(notesFragmentDefinition).create(({ defineRoute }) => [
  defineRoute({
    method: "GET",
    path: "/notes",
    outputSchema: z.array(z.object({ id: z.string(), content: z.string() })),
    handler: async function (_input, { json }) {
      const notes = await this.handlerTx()
        .retrieve(({ forSchema }) =>
          forSchema(notesSchema).find("notes", (b) =>
            b.whereIndex("idx_notes_all", (eb) => eb("id", "!=", "")),
          ),
        )
        .transformRetrieve(([rows]) =>
          rows.map((row) => ({ id: row.id.valueOf(), content: row.content })),
        )
        .execute();

      return json(notes);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/notes",
    inputSchema: z.object({ content: z.string() }),
    outputSchema: z.object({ id: z.string(), content: z.string() }),
    handler: async function ({ input }, { json }) {
      const body = await input.valid();
      const note = await this.handlerTx()
        .mutate(({ forSchema }) => forSchema(notesSchema).create("notes", body))
        .transform(({ mutateResult }) => ({ id: mutateResult.valueOf(), content: body.content }))
        .execute();

      return json(note);
    },
  }),
]);

function createNotesClient(config: Parameters<typeof createClientBuilder>[1]) {
  const builder = createClientBuilder(notesFragmentDefinition, config, [notesRoutes]);

  return {
    useNotes: builder.createHook("/notes"),
    useCreateNote: builder.createMutator("POST", "/notes"),
  };
}

describe("client flow test utilities", () => {
  it("drives vanilla client stores through backend routes into an in-memory database", async () => {
    const { fragments, test } = await buildDatabaseFragmentsTest()
      .withTestAdapter({ type: "kysely-sqlite" })
      .withFragment(
        "notes",
        instantiate(notesFragmentDefinition).withConfig({}).withRoutes([notesRoutes]),
      )
      .build();

    try {
      const client = useFragno(
        createNotesClient(createFragmentTestClientConfig(fragments.notes.fragment)),
      );

      const notesStore = client.useNotes();
      const initial = await waitForStore(
        notesStore,
        (state) => state.loading === false && Array.isArray(state.data),
      );
      expect(initial.data).toEqual([]);

      const created = await client.useCreateNote().mutate({ body: { content: "hello" } });
      expect(created).toEqual({ id: expect.any(String), content: "hello" });

      const refreshed = await waitForStore(
        notesStore,
        (state) => state.loading === false && state.data?.length === 1,
      );
      expect(refreshed.data).toEqual([created]);

      const routeResponse = await fragments.notes.callRoute("GET", "/notes");
      expect(routeResponse.type).toBe("json");
      if (routeResponse.type === "json") {
        expect(routeResponse.data).toEqual([created]);
      }
    } finally {
      await test.cleanup();
    }
  });
});
