/** Converts a logical schema namespace into Fragno's default physical database namespace. */
export function sanitizeNamespace(namespace: string): string {
  return namespace.replace(/-/g, "_");
}

/** Resolves the physical namespace used when registering a schema with a database adapter. */
export function resolveDatabaseNamespace(
  schemaName: string,
  databaseNamespace?: string | null,
): string | null {
  return databaseNamespace !== undefined ? databaseNamespace : sanitizeNamespace(schemaName);
}
