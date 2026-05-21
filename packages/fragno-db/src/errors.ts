export class DatabaseError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "DatabaseError";
    this.cause = options.cause;
  }

  get isRetryable(): boolean {
    return false;
  }
}

export type DatabaseConstraintKind = "unique" | "foreign-key" | "not-null" | "check";

export type DatabaseConstraintErrorOptions = {
  kind: DatabaseConstraintKind;
  message?: string;
  table?: string;
  constraint?: string;
  columns?: string[];
  cause?: unknown;
};

export class DatabaseConstraintError extends DatabaseError {
  readonly kind: DatabaseConstraintKind;
  readonly table?: string;
  readonly constraint?: string;
  readonly columns?: string[];

  constructor(options: DatabaseConstraintErrorOptions) {
    super(options.message ?? buildConstraintErrorMessage(options), { cause: options.cause });
    this.name = "DatabaseConstraintError";
    this.kind = options.kind;
    this.table = options.table;
    this.constraint = options.constraint;
    this.columns = options.columns;
  }
}

export type DatabaseTransactionErrorOptions = {
  message?: string;
  retryable?: boolean;
  cause?: unknown;
};

export class DatabaseTransactionError extends DatabaseError {
  readonly #retryable: boolean;

  constructor(options: DatabaseTransactionErrorOptions = {}) {
    super(options.message ?? "Database transaction failed.", { cause: options.cause });
    this.name = "DatabaseTransactionError";
    this.#retryable = options.retryable ?? false;
  }

  override get isRetryable(): boolean {
    return this.#retryable;
  }
}

const buildConstraintErrorMessage = (options: DatabaseConstraintErrorOptions): string => {
  const parts = [`Database ${options.kind} constraint violation`];
  if (options.table) {
    parts.push(`on table ${options.table}`);
  }
  if (options.columns && options.columns.length > 0) {
    parts.push(`for columns ${options.columns.join(", ")}`);
  }
  if (options.constraint) {
    parts.push(`(${options.constraint})`);
  }
  return `${parts.join(" ")}.`;
};

export function isDatabaseError(error: unknown): error is DatabaseError {
  return error instanceof DatabaseError;
}

export function isRetryableDatabaseError(error: unknown): error is DatabaseError {
  return isDatabaseError(error) && error.isRetryable;
}

export function isDatabaseConstraintError(error: unknown): error is DatabaseConstraintError {
  return error instanceof DatabaseConstraintError;
}

export function isUniqueConstraintError(error: unknown): error is DatabaseConstraintError {
  return isDatabaseConstraintError(error) && error.kind === "unique";
}
