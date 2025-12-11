import type { UOWDecoder } from "../../query/unit-of-work/unit-of-work";
import { decodeResultSet } from "../../query/result-set-decoding";
import type { SQLProvider } from "../../shared/providers";

/**
 * Creates a UOWDecoder for Kysely that transforms raw query results into application format.
 *
 * The decoder handles:
 * - Count operations (returning number directly)
 * - Regular queries (decoding rows using provider-specific logic)
 * - Cursor-based pagination (generating cursors and handling hasNextPage)
 *
 * @param provider - SQL provider for proper result decoding
 * @returns A UOWDecoder instance for transforming results
 */
export function createKyselyUOWDecoder(provider: SQLProvider): UOWDecoder<unknown> {
  return (rawResults, ops) => {
    if (rawResults.length !== ops.length) {
      throw new Error("rawResults and ops must have the same length");
    }

    return rawResults.map((rows, index) => {
      const op = ops[index];
      if (!op) {
        throw new Error("op must be defined");
      }

      const rowArray = rows as Record<string, unknown>[];
      return decodeResultSet(rowArray, op, provider);
    });
  };
}
