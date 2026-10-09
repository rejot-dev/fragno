import { z } from "zod";

/** Where Backoffice work runs. */
export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

const backofficeSystemScopeSchema = z.object({ kind: z.literal("system") });
export const backofficeOrganizationScopeSchema = z.object({
  kind: z.literal("org"),
  orgId: z.string().trim().min(1),
});
export const backofficeUserScopeSchema = z.object({
  kind: z.literal("user"),
  userId: z.string().trim().min(1),
});
export const backofficeProjectScopeSchema = z.object({
  kind: z.literal("project"),
  orgId: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
});

export const backofficeRoutableScopeSchema = z.discriminatedUnion("kind", [
  backofficeOrganizationScopeSchema,
  backofficeUserScopeSchema,
  backofficeProjectScopeSchema,
]);

export const backofficeContextScopeSchema = z.discriminatedUnion("kind", [
  backofficeSystemScopeSchema,
  backofficeOrganizationScopeSchema,
  backofficeUserScopeSchema,
  backofficeProjectScopeSchema,
]);

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
