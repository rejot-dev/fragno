import { z } from "zod";

import { backofficeRoutableScopeSchema } from "@/backoffice-runtime/context-schema";
import type { BackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";

export const generatedUiUploadScopeSchema = z.union([
  z.strictObject({ kind: z.literal("current") }),
  backofficeRoutableScopeSchema,
]);

export type GeneratedUiUploadScope = z.infer<typeof generatedUiUploadScopeSchema>;

export function resolveGeneratedUiUploadScope(
  scope: GeneratedUiUploadScope,
  currentScope: BackofficeRoutableScope | undefined,
): BackofficeRoutableScope {
  if (scope.kind !== "current") {
    return scope;
  }
  if (!currentScope) {
    throw new Error("The current Backoffice context does not support private file uploads.");
  }
  return currentScope;
}
