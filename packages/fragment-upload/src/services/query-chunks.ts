// Durable Object SQLite binds at most 100 parameters per statement; each chunked lookup adds one or
// two fixed parameters to its `in` list.
const QUERY_CHUNK_SIZE = 90;

/** Splits the values of an `in` lookup into lists one statement can bind. */
export function chunkQueryValues<T>(values: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + QUERY_CHUNK_SIZE));
  }
  return chunks;
}
