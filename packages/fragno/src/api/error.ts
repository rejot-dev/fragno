import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { StatusCode } from "../http/http-status";

export class FragnoApiError extends Error {
  readonly #status: StatusCode;
  readonly #code: string;

  constructor({ message, code }: { message: string; code: string }, status: StatusCode) {
    super(message);
    this.name = "FragnoApiError";
    this.#status = status;
    this.#code = code;
  }

  get status() {
    return this.#status;
  }

  get code() {
    return this.#code;
  }

  toResponse() {
    return Response.json({ error: this.message, code: this.code }, { status: this.status });
  }
}

export class FragnoApiValidationError extends FragnoApiError {
  #issues: readonly StandardSchemaV1.Issue[];

  constructor(message: string, issues: readonly StandardSchemaV1.Issue[]) {
    super({ message, code: "FRAGNO_VALIDATION_ERROR" }, 400);
    this.name = "FragnoApiValidationError";
    this.#issues = issues;
  }

  get issues() {
    return this.#issues;
  }

  override toResponse() {
    return Response.json(
      { error: this.message, issues: this.#issues, code: this.code },
      { status: this.status },
    );
  }
}
