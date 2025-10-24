/**
 * Maps logical table names (used by fragment authors) to physical table names (with namespace suffix)
 */
export interface TableNameMapper {
  toPhysical(logicalName: string): string;
  toLogical(physicalName: string): string;
}

/**
 * Creates a table name mapper for a given namespace.
 * Physical names have format: {logicalName}_{namespace}
 */
export function createTableNameMapper(namespace: string): TableNameMapper {
  return {
    toPhysical: (logicalName: string) => `${logicalName}_${namespace}`,
    toLogical: (physicalName: string) => {
      if (physicalName.endsWith(`_${namespace}`)) {
        return physicalName.slice(0, -(namespace.length + 1));
      }
      return physicalName;
    },
  };
}
