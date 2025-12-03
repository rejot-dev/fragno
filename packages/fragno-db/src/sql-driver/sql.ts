import type { CompiledQuery } from "./sql-driver";

export class RawBuilder {
  #sql: string;
  #parameters: unknown[];

  constructor(sql: string, parameters: unknown[] = []) {
    this.#sql = sql;
    this.#parameters = parameters;
  }

  get sql(): string {
    return this.#sql;
  }

  get parameters(): unknown[] {
    return this.#parameters;
  }

  build(): CompiledQuery {
    return {
      sql: this.#sql,
      parameters: this.#parameters,
    };
  }
}

/**
 * Tagged template function for building SQL queries with parameters.
 *
 * @example
 * ```ts
 * const userId = 123;
 * const query = sql`SELECT * FROM users WHERE id = ${userId}`;
 * ```
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): RawBuilder {
  let sqlString = strings[0];
  const parameters: unknown[] = [];

  for (let i = 0; i < values.length; i++) {
    sqlString += `?${strings[i + 1]}`;
    parameters.push(values[i]);
  }

  return new RawBuilder(sqlString, parameters);
}
