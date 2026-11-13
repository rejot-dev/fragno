import type { PackageConnectionCheck } from "@fragno-dev/backoffice-api/v0/marketplace";

/** Connections break, so a check only vouches for them for a day. */
export const PACKAGE_CONNECTION_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Declared entries are plain words; "(optional)" at the end marks a service the package can do without. */
export function isOptionalPackageConnection(connection: string): boolean {
  return /\(optional\)\s*$/i.test(connection);
}

export type PackageConnectionStatus = {
  name: string;
  optional: boolean;
  status: "ready" | "not-ready" | "unchecked";
  detail: string | null;
};

const connectionKey = (connection: string) => connection.trim().toLowerCase();

/**
 * What the latest check found for each declared connection of `version`. A check of another
 * version, or one older than a day, vouches for none of them.
 */
export function packageConnectionStatuses({
  declared,
  version,
  check,
  now,
}: {
  declared: readonly string[];
  version: string;
  check: PackageConnectionCheck | null;
  now: Date;
}): PackageConnectionStatus[] {
  const current =
    check?.version === version &&
    now.getTime() - Date.parse(check.confirmedAt) <= PACKAGE_CONNECTION_CHECK_MAX_AGE_MS
      ? check
      : null;
  return declared.map((name) => {
    const result = current?.results.find(
      (candidate) => connectionKey(candidate.connection) === connectionKey(name),
    );
    return {
      name,
      optional: isOptionalPackageConnection(name),
      status: result ? (result.ready ? "ready" : "not-ready") : "unchecked",
      detail: result ? result.detail || null : null,
    };
  });
}

/** The required connections the latest check does not show ready, which block installing. */
export function unconfirmedPackageConnections(
  input: Parameters<typeof packageConnectionStatuses>[0],
): string[] {
  return packageConnectionStatuses(input)
    .filter((connection) => !connection.optional && connection.status !== "ready")
    .map((connection) => connection.name);
}

/** A refusal to install until the connections agent has found the release's services connected. */
export class PackageConnectionsUnconfirmedError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Connect ${missing.join(", ")} before installing this release. Ask the connections agent to check them; it records the result with packages.confirmConnections.`,
    );
    this.name = "PackageConnectionsUnconfirmedError";
  }
}
