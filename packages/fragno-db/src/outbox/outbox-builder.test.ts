import { describe, expect, it, assert } from "vitest";

import type { MutationOperation } from "../query/unit-of-work/unit-of-work";
import { materializeRuntimeCreateValues } from "../query/value-encoding";
import type { AnySchema } from "../schema/create";
import { column, idColumn, schema } from "../schema/create";
import { buildOutboxPlan, finalizeOutboxPayload } from "./outbox-builder";

const defaultsSchema = schema("outbox_defaults", (s) =>
  s.addTable("records", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("label", column("string"))
      .addColumn("status", column("string").defaultTo("pending"))
      .addColumn("empty", column("string").defaultTo(""))
      .addColumn("count", column("integer").defaultTo(0))
      .addColumn("enabled", column("bool").defaultTo(false))
      .addColumn("score", column("bigint").defaultTo(0n))
      .addColumn("metadata", column("json").defaultTo({ source: "default" }))
      .addColumn(
        "createdAt",
        column("timestamp").defaultTo((builder) => builder.now()),
      )
      .addColumn("nickname", column("string").nullable().defaultTo("anonymous"))
      .addColumn(
        "runtimeLabel",
        column("string").defaultTo$(() => "runtime-generated"),
      )
      .addColumn(
        "hiddenRuntimeLabel",
        column("string")
          .defaultTo$(() => "hidden-runtime-generated")
          .hidden(),
      ),
  ),
);

function createOperation(
  values: Record<string, unknown>,
): MutationOperation<AnySchema> & { type: "create" } {
  return {
    type: "create",
    schema: defaultsSchema,
    namespace: defaultsSchema.name,
    table: "records",
    generatedExternalId: String(values["id"]),
    values: values as never,
  };
}

describe("buildOutboxPlan", () => {
  it("materializes omitted visible database defaults", () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    const plan = buildOutboxPlan([
      createOperation({
        id: "record-1",
        label: "Defaulted",
        runtimeLabel: "runtime-generated",
      }),
    ]);

    const payload = finalizeOutboxPayload(plan, 1n, { now });
    const mutation = payload.mutations[0];
    assert(mutation.op === "create");
    expect(mutation.values).toEqual({
      id: "record-1",
      label: "Defaulted",
      status: "pending",
      empty: "",
      count: 0,
      enabled: false,
      score: 0n,
      metadata: { source: "default" },
      createdAt: now,
      nickname: "anonymous",
      runtimeLabel: "runtime-generated",
    });
    expect(mutation.values).not.toHaveProperty("_internalId");
    expect(mutation.values).not.toHaveProperty("_version");
  });

  it("omits hidden runtime defaults from materialized create payloads", () => {
    const operation = createOperation({
      id: "record-hidden-runtime",
      label: "Hidden runtime",
    });
    const table = defaultsSchema.tables.records;
    const materializedOperation = {
      ...operation,
      values: materializeRuntimeCreateValues(operation.values, table),
    };

    const plan = buildOutboxPlan([materializedOperation]);
    const payload = finalizeOutboxPayload(plan, 2n, {
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const mutation = payload.mutations[0];
    assert(mutation.op === "create");
    expect(mutation.values).toMatchObject({
      runtimeLabel: "runtime-generated",
    });
    expect(mutation.values).not.toHaveProperty("hiddenRuntimeLabel");
  });

  it("preserves explicit falsy and nullable values instead of replacing them with defaults", () => {
    const plan = buildOutboxPlan([
      createOperation({
        id: "record-2",
        label: "Explicit",
        status: "",
        empty: "provided",
        count: 7,
        enabled: true,
        score: 9n,
        metadata: { source: "provided" },
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
        nickname: null,
        runtimeLabel: "provided-runtime",
      }),
    ]);

    const payload = finalizeOutboxPayload(plan, 3n, {
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    const mutation = payload.mutations[0];
    assert(mutation.op === "create");
    expect(mutation.values).toMatchObject({
      status: "",
      empty: "provided",
      count: 7,
      enabled: true,
      score: 9n,
      metadata: { source: "provided" },
      createdAt: new Date("2026-07-20T12:00:00.000Z"),
      nickname: null,
      runtimeLabel: "provided-runtime",
    });
  });
});
