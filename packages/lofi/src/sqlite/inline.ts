const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Writes `params` into `sql` as literals in place of its `?` placeholders, so several statements
 * can go to the database in one call: a connection binds parameters only when a call holds one
 * statement. Returns null when a value has no literal that SQLite reads back exactly as the bound
 * value, such as a fraction, whose decimal text SQLite may round differently, or when `sql` is not
 * exactly one statement or uses other placeholders or comments; the statement then goes on its own.
 * wa-sqlite stops at the first empty statement of a call, so a stray semicolon would silently skip
 * the statements after it.
 */
export function inlineSqliteParams(sql: string, params: ReadonlyArray<unknown>): string | null {
  if (sql.trim() === "") {
    return null;
  }
  const literals: string[] = [];
  for (const param of params) {
    const literal = sqliteLiteral(param);
    if (literal === null) {
      return null;
    }
    literals.push(literal);
  }

  let inlined = "";
  let next = 0;
  let quote: string | null = null;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];
    if (quote !== null) {
      // A doubled quote inside a quoted string or identifier closes and reopens it.
      if (character === quote) {
        quote = null;
      }
      inlined += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      inlined += character;
    } else if (character === "?") {
      if (/[0-9]/u.test(sql[index + 1] ?? "") || next === literals.length) {
        return null;
      }
      inlined += literals[next++];
    } else if (
      character === ";" ||
      character === ":" ||
      character === "@" ||
      character === "$" ||
      sql.startsWith("--", index) ||
      sql.startsWith("/*", index)
    ) {
      // Named parameters are not inlined, and a comment could hide a quote or a placeholder.
      // Literals never contain these characters outside quotes.
      return null;
    } else {
      inlined += character;
    }
  }
  return quote === null && next === literals.length ? inlined : null;
}

/** Mirrors how wa-sqlite binds a value; null where a literal would store something else. */
function sqliteLiteral(value: unknown): string | null {
  if (value === null || value === undefined) {
    return "NULL";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "1" : "0";
    case "number":
      // wa-sqlite binds 32-bit integers as INTEGER and every other number as REAL.
      return value === (value | 0) ? signed(String(value)) : null;
    case "bigint":
      // The literal -9223372036854775808 is read as a negated REAL.
      return value > INT64_MIN && value <= INT64_MAX ? signed(String(value)) : null;
    case "string":
      // SQL text ends at a NUL character; a bound string keeps it.
      return value.includes("\u0000") ? null : `'${value.replaceAll("'", "''")}'`;
    case "object":
      return value instanceof Uint8Array && value.length > 0
        ? `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`
        : null;
    case "undefined":
    case "function":
    case "symbol":
      break;
  }
  return null;
}

/** Parenthesizes negative numbers, so `x - ?` does not become the comment `x --1`. */
function signed(literal: string): string {
  return literal.startsWith("-") ? `(${literal})` : literal;
}
