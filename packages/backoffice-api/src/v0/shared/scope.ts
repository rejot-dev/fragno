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
