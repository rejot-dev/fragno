import type { BackofficeObjectScope } from "@/backoffice-runtime/object-registry";

export const UPLOAD_PROVIDER_DATABASE = "database" as const;

function storagePrefixSegment(value: string): string {
  const segment = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`'${value}' cannot be converted into a storage key prefix.`);
  }
  return segment;
}

/**
 * Prefixes every storage key a scope's Upload or Blobs object writes, so scopes sharing storage
 * never address each other's objects. Organizations keep the `org/` prefix their files were stored
 * under; every other scope is named by its encoded object name.
 */
export function scopeStorageKeyPrefix(
  scope: Exclude<BackofficeObjectScope, { kind: "singleton" }>,
  objectName: string,
): string {
  if (scope.kind === "org") {
    return `org/${storagePrefixSegment(scope.orgId)}`;
  }
  const name = scope.kind === "named" ? scope.name : objectName;
  return `named/${name.split("/").map(storagePrefixSegment).join("/")}`;
}
