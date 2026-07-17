import { DatabaseConstraintError } from "../../errors";

export class UniqueConstraintError extends DatabaseConstraintError {
  constructor(options: {
    message: string;
    table?: string;
    constraint?: string;
    columns?: string[];
  }) {
    super({ kind: "unique", ...options });
    this.name = "UniqueConstraintError";
  }
}

export class ForeignKeyConstraintError extends DatabaseConstraintError {
  constructor(message: string) {
    super({ kind: "foreign-key", message });
    this.name = "ForeignKeyConstraintError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
