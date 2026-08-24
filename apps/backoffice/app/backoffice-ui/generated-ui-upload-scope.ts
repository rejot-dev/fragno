import { z } from "zod";

import { backofficeRoutableScopeSchema } from "@/backoffice-runtime/context-schema";
import type { BackofficeRoutableResolvedScope } from "@/backoffice-runtime/resolved-scope";

export const generatedUiUploadScopeSchema = z.union([
  z.strictObject({ kind: z.literal("current") }),
  backofficeRoutableScopeSchema,
]);

export type GeneratedUiUploadScope = z.infer<typeof generatedUiUploadScopeSchema>;

export function resolveGeneratedUiUploadScope(
  scope: GeneratedUiUploadScope,
  currentScope: BackofficeRoutableResolvedScope | undefined,
): BackofficeRoutableResolvedScope {
  if (scope.kind === "current") {
    if (!currentScope) {
      throw new Error("The current Backoffice context does not support private file uploads.");
    }
    return currentScope;
  }
  if (scope.kind === "user") {
    return scope;
  }
  if (
    !currentScope ||
    (currentScope.kind !== "org" && currentScope.kind !== "project") ||
    currentScope.organization.id !== scope.orgId
  ) {
    throw new Error("Generated UI uploads cannot target another organization.");
  }
  return scope.kind === "org"
    ? { kind: "org", organization: currentScope.organization }
    : {
        kind: "project",
        organization: currentScope.organization,
        projectId: scope.projectId,
      };
}
