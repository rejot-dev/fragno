import { describe, expect, test } from "vitest";

import { FragnoId, column, idColumn, schema } from "../../schema/create";
import { getDbNowOffsetMs, isDbNow } from "../db-now";
import {
  MutationRecorder,
  type MutationOperation,
  type SchemaMutationRecorder,
} from "./mutation-recorder";
import {
  TypedUnitOfWork,
  createUnitOfWork,
  type UOWCompiler,
  type UOWDecoder,
} from "./unit-of-work";

const recorderSchema = schema("mutation_recorder", (s) =>
  s.addTable("record", (t) =>
    t
      .addColumn("id", idColumn())
      .addColumn("note", column("string"))
      .addColumn("createdAt", column("timestamp")),
  ),
);

type RecorderApi = Pick<
  SchemaMutationRecorder<typeof recorderSchema>,
  "create" | "update" | "delete" | "check"
>;

const recordMutationPlan = (records: RecorderApi) => {
  const id = new FragnoId({ externalId: "record-1", internalId: 7n, version: 3 });
  records.create("record", {
    id: "created-record",
    note: "created",
    createdAt: new Date("2026-07-29T12:00:00.000Z"),
  });
  records.update("record", id, (builder) =>
    builder.set({ note: "updated", createdAt: builder.now().plus({ minutes: 1 }) }).check(),
  );
  records.delete("record", id, (builder) => builder.check());
  records.check("record", id);
};

const normalizeMutationValue = (value: unknown): unknown => {
  if (value instanceof FragnoId) {
    return {
      externalId: value.externalId,
      internalId: value.internalId,
      version: value.version,
    };
  }
  if (isDbNow(value)) {
    return { tag: value.tag, offsetMs: getDbNowOffsetMs(value) };
  }
  if (Array.isArray(value)) {
    return value.map(normalizeMutationValue);
  }
  if (value instanceof Date || value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalizeMutationValue(item)]),
  );
};

const normalizeMutationOperation = (operation: MutationOperation<typeof recorderSchema>) => ({
  ...operation,
  schema: { name: operation.schema.name, version: operation.schema.version },
  ...("id" in operation ? { id: normalizeMutationValue(operation.id) } : {}),
  ...("values" in operation ? { values: normalizeMutationValue(operation.values) } : {}),
  ...("set" in operation ? { set: normalizeMutationValue(operation.set) } : {}),
});

const createPlanningUnitOfWork = () => {
  const compiler: UOWCompiler<unknown> = {
    compileRetrievalOperation: () => null,
    compileMutationOperation: () => null,
  };
  const executor = {
    executeRetrievalPhase: async () => [],
    executeMutationPhase: async () => ({ success: true, createdInternalIds: [] }),
  };
  const decoder: UOWDecoder = { decode: (rawResults) => rawResults };
  return createUnitOfWork(compiler, executor, decoder);
};

describe("MutationRecorder", () => {
  test("is bound internally when constructing a TypedUnitOfWork", () => {
    const uow = createPlanningUnitOfWork();
    const typedUow = new TypedUnitOfWork(recorderSchema, "records_namespace", uow);

    typedUow.create("record", {
      id: "created-record",
      note: "created",
      createdAt: new Date("2026-07-29T12:00:00.000Z"),
    });

    expect(uow.getMutationOperations()).toMatchObject([
      {
        type: "create",
        schema: recorderSchema,
        namespace: "records_namespace",
        table: "record",
      },
    ]);
  });

  test("is the canonical mutation implementation used by UnitOfWork", () => {
    const standaloneOperations: MutationOperation<typeof recorderSchema>[] = [];
    const standalone = new MutationRecorder((operation) => {
      standaloneOperations.push(operation as MutationOperation<typeof recorderSchema>);
    }).forSchema(recorderSchema, "records_namespace");
    recordMutationPlan(standalone);

    const uow = createPlanningUnitOfWork();
    uow.registerSchema(recorderSchema, "records_namespace");
    recordMutationPlan(uow.forSchema(recorderSchema));

    expect(
      uow
        .getMutationOperations()
        .map((operation) =>
          normalizeMutationOperation(operation as MutationOperation<typeof recorderSchema>),
        ),
    ).toEqual(standaloneOperations.map(normalizeMutationOperation));
  });
});
