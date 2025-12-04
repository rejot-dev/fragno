/**
 * Sanitizes a namespace for use in database table names and TypeScript exports.
 * Converts dashes to underscores to ensure compatibility with SQL identifiers
 * and Drizzle's relational query system.
 *
 * @example
 * sanitizeNamespace("my-fragment") // => "my_fragment"
 */
export function sanitizeNamespace(namespace: string): string {
  return namespace.replace(/-/g, "_");
}

/**
 * Maps logical table names (used by fragment authors) to physical table names (with namespace suffix)
 */
export interface TableNameMapper {
  toPhysical(logicalName: string): string;
  toLogical(physicalName: string): string;
}

/**
 * Creates a table name mapper for a given namespace.
 * Physical names have format: {logicalName}_{namespace} (or {logicalName}_{sanitizedNamespace} if sanitize is true)
 *
 * @param namespace - The namespace to use for table name prefixing
 * @param sanitize - Whether to sanitize the namespace by converting dashes to underscores (default: false)
 * @returns A table name mapper with toPhysical and toLogical methods
 *
 * @example
 * const mapper = createTableNameMapper("my-fragment");
 * mapper.toPhysical("users") // => "users_my-fragment"
 *
 * @example
 * const mapper = createTableNameMapper("my-fragment", true);
 * mapper.toPhysical("users") // => "users_my_fragment"
 * mapper.toLogical("users_my_fragment") // => "users"
 */
export function createTableNameMapper(namespace: string, sanitize = false): TableNameMapper {
  const processedNamespace = sanitize ? sanitizeNamespace(namespace) : namespace;

  return {
    toPhysical: (logicalName: string) => `${logicalName}_${processedNamespace}`,
    toLogical: (physicalName: string) => {
      if (physicalName.endsWith(`_${processedNamespace}`)) {
        return physicalName.slice(0, -(processedNamespace.length + 1));
      }
      return physicalName;
    },
  };
}
