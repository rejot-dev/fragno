import { z } from "zod";

/** Where Backoffice work runs. */
export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

/** Scopes that own resources; system scope only administers them. */
export type BackofficeRoutableScope = Extract<
  BackofficeContextScope,
  { kind: "org" | "project" | "user" }
>;

const backofficeSystemScopeSchema = z.strictObject({ kind: z.literal("system") });
export const backofficeOrganizationScopeSchema = z.strictObject({
  kind: z.literal("org"),
  orgId: z.string().trim().min(1),
});
export const backofficeUserScopeSchema = z.strictObject({
  kind: z.literal("user"),
  userId: z.string().trim().min(1),
});
export const backofficeProjectScopeSchema = z.strictObject({
  kind: z.literal("project"),
  orgId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});

export const backofficeRoutableScopeSchema = z.discriminatedUnion("kind", [
  backofficeOrganizationScopeSchema,
  backofficeUserScopeSchema,
  backofficeProjectScopeSchema,
]) satisfies z.ZodType<BackofficeRoutableScope>;

export const backofficeContextScopeSchema = z.discriminatedUnion("kind", [
  backofficeSystemScopeSchema,
  backofficeOrganizationScopeSchema,
  backofficeUserScopeSchema,
  backofficeProjectScopeSchema,
]) satisfies z.ZodType<BackofficeContextScope>;

export function isBackofficeRoutableScope(
  scope: BackofficeContextScope,
): scope is BackofficeRoutableScope {
  return scope.kind !== "system";
}

export function backofficeContextScopesEqual(
  left: BackofficeContextScope,
  right: BackofficeContextScope,
): boolean {
  // The path segment names a scope exactly, so equal segments mean equal scopes.
  return backofficeScopePathSegment(left) === backofficeScopePathSegment(right);
}

/** A scope restriction is an upper bound: an organization contains its projects. */
export function backofficeScopeContains(
  restriction: BackofficeContextScope,
  target: BackofficeContextScope,
): boolean {
  return (
    backofficeContextScopesEqual(restriction, target) ||
    (restriction.kind === "org" && target.kind === "project" && restriction.orgId === target.orgId)
  );
}

const INVALID_BACKOFFICE_SCOPE = "INVALID_BACKOFFICE_SCOPE";

/** A scope could not be read from untrusted text, such as a URL. */
export class BackofficeScopeParseError extends Error {
  readonly code = INVALID_BACKOFFICE_SCOPE;

  constructor(message: string) {
    super(message);
    this.name = "BackofficeScopeParseError";
  }
}

/** Matches by code too, because errors lose their class across module copies and RPC. */
export function isBackofficeScopeParseError(error: unknown): error is BackofficeScopeParseError {
  return (
    error instanceof BackofficeScopeParseError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === INVALID_BACKOFFICE_SCOPE)
  );
}

/**
 * Names a scope in one URL path segment, e.g. `project:<orgId>:<projectId>`. Ids are
 * URI-encoded, so `:` only ever separates components.
 */
export function backofficeScopePathSegment(scope: BackofficeContextScope): string {
  if (scope.kind === "system") {
    return "system";
  }
  if (scope.kind === "project") {
    return `project:${encodeURIComponent(scope.orgId)}:${encodeURIComponent(scope.projectId)}`;
  }
  return scope.kind === "org"
    ? `org:${encodeURIComponent(scope.orgId)}`
    : `user:${encodeURIComponent(scope.userId)}`;
}

function decodePathSegmentComponent(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new BackofficeScopeParseError(`Invalid ${label} encoding.`);
  }
  if (!decoded) {
    throw new BackofficeScopeParseError(`Missing ${label}.`);
  }
  return decoded;
}

/** Reads a segment written by `backofficeScopePathSegment`; anything else is a parse error. */
export function parseBackofficeScopePathSegment(segment: string): BackofficeContextScope {
  const [kind, ...ids] = segment.split(":");
  const expectIds = (count: number, message: string) => {
    if (ids.length !== count) {
      throw new BackofficeScopeParseError(message);
    }
  };
  switch (kind) {
    case "system":
      expectIds(0, "System scope does not accept id components.");
      return { kind: "system" };
    case "org":
      expectIds(1, "Org scope requires exactly one id component.");
      return { kind: "org", orgId: decodePathSegmentComponent(ids[0] ?? "", "org id") };
    case "user":
      expectIds(1, "User scope requires exactly one id component.");
      return { kind: "user", userId: decodePathSegmentComponent(ids[0] ?? "", "user id") };
    case "project":
      expectIds(2, "Project scope requires org and project id components.");
      return {
        kind: "project",
        orgId: decodePathSegmentComponent(ids[0] ?? "", "org id"),
        projectId: decodePathSegmentComponent(ids[1] ?? "", "project id"),
      };
    default:
      throw new BackofficeScopeParseError(`Unknown scope kind '${kind}'.`);
  }
}
