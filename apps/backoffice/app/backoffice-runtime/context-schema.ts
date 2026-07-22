import { z } from "zod";

import type { BackofficeContextScope } from "./context";

export const backofficeSystemScopeSchema = z.object({ kind: z.literal("system") });
export const backofficeOrganisationScopeSchema = z.object({
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

export const backofficeContextScopeSchema: z.ZodType<BackofficeContextScope> = z.discriminatedUnion(
  "kind",
  [
    backofficeSystemScopeSchema,
    backofficeOrganisationScopeSchema,
    backofficeUserScopeSchema,
    backofficeProjectScopeSchema,
  ],
);
