import { z } from "zod";

import type { BackofficeContextScope } from "./context";
import type { BackofficeRoutableScope } from "./scope-codec";

export const backofficeSystemScopeSchema = z.object({ kind: z.literal("system") });
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

export const backofficeRoutableScopeSchema: z.ZodType<BackofficeRoutableScope> =
  z.discriminatedUnion("kind", [
    backofficeOrganizationScopeSchema,
    backofficeUserScopeSchema,
    backofficeProjectScopeSchema,
  ]);

export const backofficeContextScopeSchema: z.ZodType<BackofficeContextScope> = z.discriminatedUnion(
  "kind",
  [
    backofficeSystemScopeSchema,
    backofficeOrganizationScopeSchema,
    backofficeUserScopeSchema,
    backofficeProjectScopeSchema,
  ],
);
