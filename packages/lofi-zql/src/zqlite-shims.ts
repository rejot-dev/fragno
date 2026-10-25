// Stands in for zqlite's native-binding modules in the vendored TableSource; see
// scripts/vendor-zql.mjs.

/**
 * The scan-status opcodes TableSource reads in debug mode. Our statements report no scan status,
 * so the values only need to exist.
 */
const SQLite3Database = {
  SQLITE_SCANSTAT_NVISIT: 0,
  SQLITE_SCANSTAT_NAME: 3,
  SQLITE_SCANSTAT_EXPLAIN: 4,
} as const;

export default SQLite3Database;

/** zero-cache counts index reads for its metrics; a browser replica has none to report. */
export function recordIndexUsage(_statement: unknown, _table: string): void {}
