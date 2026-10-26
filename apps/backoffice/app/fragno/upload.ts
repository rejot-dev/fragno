import type { BackofficeObjectScope } from "@/backoffice-runtime/object-registry";

export const UPLOAD_PROVIDER_DATABASE = "database" as const;

function storagePrefixSegment(value: string): string {
  const segment = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!segment || segment === "." || segment === "..") {
    throw new Error(`'${value}' cannot be converted into an Upload storage key prefix.`);
  }
  return segment;
}

/**
 * Prefixes every storage key an Upload object writes. Organizations keep the `org/` prefix their
 * files were stored under; every other scope is named by its encoded object name.
 */
export function uploadStorageKeyPrefix(
  scope: Exclude<BackofficeObjectScope, { kind: "singleton" }>,
  objectName: string,
): string {
  if (scope.kind === "org") {
    return `org/${storagePrefixSegment(scope.orgId)}`;
  }
  const name = scope.kind === "named" ? scope.name : objectName;
  return `named/${name.split("/").map(storagePrefixSegment).join("/")}`;
}
