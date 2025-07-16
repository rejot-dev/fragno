import type { StandardSchemaV1 } from "@standard-schema/spec";

export class FragnoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "FragnoApiError";
  }

  toResponse() {
    return Response.json({ error: this.message }, { status: this.status });
  }
}

export class FragnoApiValidationError extends FragnoApiError {
  #issues: readonly StandardSchemaV1.Issue[];

  constructor(message: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(message, 400);
    this.name = "FragnoApiValidationError";
    this.#issues = issues;
  }

  get issues() {
    return this.#issues;
  }

  override toResponse() {
    return Response.json({ error: this.message, issues: this.#issues }, { status: this.status });
  }
}
