export class UniqueConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniqueConstraintError";
  }
}

export class ForeignKeyConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForeignKeyConstraintError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
