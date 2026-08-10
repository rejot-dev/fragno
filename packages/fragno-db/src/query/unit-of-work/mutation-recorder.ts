import type { DatabaseConstraintError } from "../../errors";
import { FragnoId, type AnySchema, type AnyTable } from "../../schema/create";
import { generateId } from "../../schema/generate-id";
import { dbInterval, dbNow, type DbInterval, type DbIntervalInput, type DbNow } from "../db-now";
import type { TableToInsertValues, TableToUpdateValues } from "../table-values";
import {
  buildCheckAbsentCondition,
  type CheckAbsentIndexName,
  type CheckAbsentIndexValues,
} from "./check-absent";

export interface UniqueConflictRetryContext {
  error: DatabaseConstraintError;
  operation: {
    type: "create" | "update";
    schema: string;
    namespace: string | null;
    table: string;
  };
}

export type UniqueConflictRetryDecider = (context: UniqueConflictRetryContext) => boolean;

export interface CreateOptions {
  /**
   * Decide whether a unique-constraint failure should be treated as an optimistic concurrency
   * conflict. The transaction's retrieval phase must resolve any accepted conflict on retry.
   */
  retryOnUniqueConflict?: UniqueConflictRetryDecider;
}

export type MutationOperation<
  TSchema extends AnySchema,
  TTable extends AnyTable = TSchema["tables"][keyof TSchema["tables"]],
> =
  | {
      type: "update";
      schema: TSchema;
      namespace?: string | null;
      table: TTable["name"];
      id: FragnoId | string;
      checkVersion: boolean;
      set: TableToUpdateValues<TTable>;
      retryOnUniqueConflict?: UniqueConflictRetryDecider;
    }
  | {
      type: "create";
      schema: TSchema;
      namespace?: string | null;
      table: TTable["name"];
      values: TableToInsertValues<TTable>;
      generatedExternalId: string;
      retryOnUniqueConflict?: UniqueConflictRetryDecider;
    }
  | {
      type: "delete";
      schema: TSchema;
      namespace?: string | null;
      table: TTable["name"];
      id: FragnoId | string;
      checkVersion: boolean;
      omitOutbox?: boolean;
    }
  | {
      type: "check";
      schema: TSchema;
      namespace?: string | null;
      table: TTable["name"];
      id: FragnoId;
    }
  | {
      type: "check-absent";
      schema: TSchema;
      namespace?: string | null;
      table: TTable["name"];
      indexName: string;
      values: Record<string, unknown>;
    };

export type RecordMutationOperation = (operation: MutationOperation<AnySchema>) => void;

/**
 * Records canonical mutation operations without owning transaction state or execution.
 */
export class MutationRecorder {
  readonly #record: RecordMutationOperation;

  constructor(record: RecordMutationOperation) {
    this.#record = record;
  }

  forSchema<TSchema extends AnySchema>(
    schema: TSchema,
    namespace?: string | null,
  ): SchemaMutationRecorder<TSchema> {
    return new SchemaMutationRecorder(schema, namespace, this.#record);
  }
}

/** The schema-bound mutation API shared by UnitOfWork and portable planners. */
export class SchemaMutationRecorder<TSchema extends AnySchema> {
  readonly #schema: TSchema;
  readonly #namespace: string | null | undefined;
  readonly #record: RecordMutationOperation;

  constructor(
    schema: TSchema,
    namespace: string | null | undefined,
    record: RecordMutationOperation,
  ) {
    this.#schema = schema;
    this.#namespace = namespace;
    this.#record = record;
  }

  now(): DbNow {
    return dbNow();
  }

  interval(input: DbIntervalInput): DbInterval {
    return dbInterval(input);
  }

  generateId(tableName: keyof TSchema["tables"] & string): FragnoId {
    return generateId(this.#schema, tableName);
  }

  create<TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    values: TableToInsertValues<TSchema["tables"][TableName]>,
    options: CreateOptions = {},
  ): FragnoId {
    const table = this.#schema.tables[tableName];
    if (!table) {
      throw new Error(`Table ${tableName} not found in schema`);
    }

    const idColumn = table.getIdColumn();
    const providedId = (values as Record<string, unknown>)[idColumn.name];
    let externalId: string;
    let recordedValues = values;

    if (providedId !== undefined) {
      externalId =
        typeof providedId === "object" && providedId !== null && "externalId" in providedId
          ? (providedId as FragnoId).externalId
          : (providedId as string);
    } else {
      const generatedId = idColumn.generateDefaultValue();
      if (generatedId === undefined) {
        throw new Error(
          `No ID value provided and ID column ${idColumn.name} has no default generator`,
        );
      }
      externalId = generatedId as string;
      recordedValues = {
        ...values,
        [idColumn.name]: externalId,
      } as TableToInsertValues<TSchema["tables"][TableName]>;
    }

    this.#record({
      type: "create",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      values: recordedValues,
      generatedExternalId: externalId,
      ...(options.retryOnUniqueConflict
        ? { retryOnUniqueConflict: options.retryOnUniqueConflict }
        : {}),
    });

    return FragnoId.fromExternal(externalId, 0);
  }

  update<TableName extends keyof TSchema["tables"] & string>(
    tableName: TableName,
    id: FragnoId | string,
    buildUpdate: (
      builder: Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build">,
    ) => Omit<UpdateBuilder<TSchema["tables"][TableName]>, "build"> | void,
  ): void {
    const builder = new UpdateBuilder<TSchema["tables"][TableName]>(tableName, id);
    buildUpdate(builder);
    const { id: operationId, checkVersion, retryOnUniqueConflict, set } = builder.build();

    this.#record({
      type: "update",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      id: operationId,
      checkVersion,
      set,
      ...(retryOnUniqueConflict ? { retryOnUniqueConflict } : {}),
    });
  }

  delete(
    tableName: keyof TSchema["tables"] & string,
    id: FragnoId | string,
    buildDelete?: (builder: Omit<DeleteBuilder, "build">) => Omit<DeleteBuilder, "build"> | void,
  ): void {
    const builder = new DeleteBuilder(tableName, id);
    buildDelete?.(builder);
    const { id: operationId, checkVersion, omitOutbox } = builder.build();

    this.#record({
      type: "delete",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      id: operationId,
      checkVersion,
      omitOutbox,
    });
  }

  check(tableName: keyof TSchema["tables"] & string, id: FragnoId): void {
    this.#record({
      type: "check",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      id,
    });
  }

  checkAbsent<
    TTableName extends keyof TSchema["tables"] & string,
    TIndexName extends CheckAbsentIndexName<TSchema["tables"][TTableName]>,
  >(
    tableName: TTableName,
    indexName: TIndexName,
    values: CheckAbsentIndexValues<TSchema["tables"][TTableName], TIndexName>,
  ): void {
    const { normalizedIndexName } = buildCheckAbsentCondition(
      this.#schema,
      tableName,
      indexName,
      values as Record<string, unknown>,
    );

    this.#record({
      type: "check-absent",
      schema: this.#schema,
      namespace: this.#namespace,
      table: tableName,
      indexName: normalizedIndexName,
      values: values as Record<string, unknown>,
    });
  }
}

export class UpdateBuilder<TTable extends AnyTable> {
  readonly #tableName: string;
  readonly #id: FragnoId | string;

  #checkVersion = false;
  #retryOnUniqueConflict?: UniqueConflictRetryDecider;
  #setValues?: TableToUpdateValues<TTable>;

  constructor(tableName: string, id: FragnoId | string) {
    this.#tableName = tableName;
    this.#id = id;
  }

  set(values: TableToUpdateValues<TTable>): this {
    this.#setValues = values;
    return this;
  }

  now(): DbNow {
    return dbNow();
  }

  interval(input: DbIntervalInput): DbInterval {
    return dbInterval(input);
  }

  check(): this {
    if (typeof this.#id === "string") {
      throw new Error(
        `Cannot use check() with a string ID on table "${this.#tableName}". ` +
          `Version checking requires a FragnoId with version information.`,
      );
    }
    this.#checkVersion = true;
    return this;
  }

  retryOnUniqueConflict(decide: UniqueConflictRetryDecider): this {
    this.#retryOnUniqueConflict = decide;
    return this;
  }

  /** @internal */
  build(): {
    id: FragnoId | string;
    checkVersion: boolean;
    retryOnUniqueConflict?: UniqueConflictRetryDecider;
    set: TableToUpdateValues<TTable>;
  } {
    if (!this.#setValues) {
      throw new Error(
        `Must specify values using .set() before finalizing update operation on table "${this.#tableName}"`,
      );
    }

    return {
      id: this.#id,
      checkVersion: this.#checkVersion,
      ...(this.#retryOnUniqueConflict
        ? { retryOnUniqueConflict: this.#retryOnUniqueConflict }
        : {}),
      set: this.#setValues,
    };
  }
}

export class DeleteBuilder {
  readonly #tableName: string;
  readonly #id: FragnoId | string;

  #checkVersion = false;
  #omitOutbox = false;

  constructor(tableName: string, id: FragnoId | string) {
    this.#tableName = tableName;
    this.#id = id;
  }

  check(): this {
    if (typeof this.#id === "string") {
      throw new Error(
        `Cannot use check() with a string ID on table "${this.#tableName}". ` +
          `Version checking requires a FragnoId with version information.`,
      );
    }
    this.#checkVersion = true;
    return this;
  }

  /** Prevent this source deletion from producing an ordinary outbox delete operation. */
  omitOutbox(): this {
    this.#omitOutbox = true;
    return this;
  }

  /** @internal */
  build(): {
    id: FragnoId | string;
    checkVersion: boolean;
    omitOutbox: boolean;
  } {
    return {
      id: this.#id,
      checkVersion: this.#checkVersion,
      omitOutbox: this.#omitOutbox,
    };
  }
}
