import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyColumn,
  Table,
  TableInsertValues,
  TableUnknownKeysMode,
  TableValidationOptions,
} from "./create";

export class FragnoDbValidationError extends Error {
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(message: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(message);
    this.name = "FragnoDbValidationError";
    this.issues = issues;
  }
}

type FragnoIdCtor = typeof import("./create").FragnoId;
type FragnoReferenceCtor = typeof import("./create").FragnoReference;

type ValidationClasses = {
  FragnoId: FragnoIdCtor;
  FragnoReference: FragnoReferenceCtor;
};

const defaultUnknownKeysMode: TableUnknownKeysMode = "strip";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseVarcharLength = (type: string): number | undefined => {
  if (!type.startsWith("varchar(") || !type.endsWith(")")) {
    return;
  }

  const rawLength = type.slice("varchar(".length, -1);
  const length = Number(rawLength);
  if (!Number.isFinite(length)) {
    return;
  }

  return length;
};

const getUnknownKeysMode = (options?: StandardSchemaV1.Options): TableUnknownKeysMode => {
  const libraryOptions = options?.libraryOptions as TableValidationOptions | undefined;
  return libraryOptions?.unknownKeys ?? defaultUnknownKeysMode;
};

const validateColumnValue = (
  col: AnyColumn,
  value: unknown,
  classes: ValidationClasses,
): string | undefined => {
  if (col.role === "external-id") {
    if (value instanceof classes.FragnoId) {
      const maxLength = parseVarcharLength(col.type);
      if (maxLength !== undefined && value.externalId.length > maxLength) {
        return `String must have at most ${maxLength} characters`;
      }
      return;
    }

    if (typeof value === "string") {
      const maxLength = parseVarcharLength(col.type);
      if (maxLength !== undefined && value.length > maxLength) {
        return `String must have at most ${maxLength} characters`;
      }
      return;
    }

    return "Expected string or FragnoId";
  }

  if (col.role === "reference") {
    if (
      value instanceof classes.FragnoReference ||
      value instanceof classes.FragnoId ||
      typeof value === "string" ||
      typeof value === "bigint"
    ) {
      return;
    }

    return "Expected reference (string, bigint, FragnoId, or FragnoReference)";
  }

  if (col.type === "string" || col.type.startsWith("varchar(")) {
    if (typeof value !== "string") {
      return "Expected string";
    }

    const maxLength = parseVarcharLength(col.type);
    if (maxLength !== undefined && value.length > maxLength) {
      return `String must have at most ${maxLength} characters`;
    }

    return;
  }

  if (col.type === "bigint") {
    return typeof value === "bigint" ? undefined : "Expected bigint";
  }

  if (col.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return "Expected integer";
    }
    return;
  }

  if (col.type === "decimal") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "Expected number";
    }
    return;
  }

  if (col.type === "bool") {
    return typeof value === "boolean" ? undefined : "Expected boolean";
  }

  if (col.type === "binary") {
    return value instanceof Uint8Array ? undefined : "Expected Uint8Array";
  }

  if (col.type === "date" || col.type === "timestamp") {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      return "Expected valid Date";
    }
    return;
  }

  if (col.type === "json") {
    return;
  }

  return;
};

const validateTableInsertValues = <TTable extends Table>(
  table: TTable,
  value: unknown,
  options: StandardSchemaV1.Options | undefined,
  classes: ValidationClasses,
): StandardSchemaV1.Result<TableInsertValues<TTable>> => {
  const issues: StandardSchemaV1.Issue[] = [];

  if (!isRecord(value)) {
    return { issues: [{ message: "Expected object" }] };
  }

  const input = value as Record<string, unknown>;
  const entries = Object.entries(table.columns).filter(([, col]) => !col.isHidden);
  const allowedKeys = new Set(entries.map(([key]) => key));
  const unknownKeysMode = getUnknownKeysMode(options);

  if (unknownKeysMode === "strict") {
    for (const key of Object.keys(input)) {
      if (!allowedKeys.has(key)) {
        issues.push({ message: `Unknown key "${key}"`, path: [key] });
      }
    }
  }

  const output: Record<string, unknown> = {};

  for (const [key, col] of entries) {
    const hasKey = Object.prototype.hasOwnProperty.call(input, key);
    const colValue = hasKey ? input[key] : undefined;
    const allowsUndefined = col.isNullable || col.default !== undefined;
    const allowsNull = col.isNullable;

    if (colValue === undefined) {
      if (!allowsUndefined) {
        issues.push({ message: "Required", path: [key] });
      }
      continue;
    }

    if (colValue === null) {
      if (!allowsNull) {
        issues.push({ message: "Required", path: [key] });
      } else {
        output[key] = null;
      }
      continue;
    }

    const issue = validateColumnValue(col, colValue, classes);
    if (issue) {
      issues.push({ message: issue, path: [key] });
      continue;
    }

    output[key] = colValue;
  }

  if (issues.length > 0) {
    return { issues };
  }

  return { value: output as TableInsertValues<TTable> };
};

export const createTableStandardSchemaProps = <TTable extends Table>(
  table: TTable,
  classes: ValidationClasses,
): StandardSchemaV1.Props<TableInsertValues<TTable>, TableInsertValues<TTable>> => ({
  version: 1,
  vendor: "fragno-db",
  validate: (value: unknown, options?: StandardSchemaV1.Options) =>
    validateTableInsertValues(table, value, options, classes),
});

export const createTableValidator = <TTable extends Table>(
  table: TTable,
  classes: ValidationClasses,
) => {
  return (value: unknown, options?: TableValidationOptions) => {
    const result = validateTableInsertValues(table, value, { libraryOptions: options }, classes);

    if (result.issues) {
      throw new FragnoDbValidationError("Validation failed", result.issues);
    }

    return result.value as TableInsertValues<TTable>;
  };
};
