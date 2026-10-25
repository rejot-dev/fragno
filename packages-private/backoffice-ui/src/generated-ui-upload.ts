import {
  type BackofficeRoutableScope,
  backofficeRoutableScopeSchema,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import { z } from "zod";

export const generatedUiUploadScopeSchema = z.union([
  z.strictObject({ kind: z.literal("current") }),
  backofficeRoutableScopeSchema,
]);

export type GeneratedUiUploadScope = z.infer<typeof generatedUiUploadScopeSchema>;

/** A file a generated UI uploaded into the workspace of `scope`, where workflows read it. */
export const generatedUiUploadedFileSchema = z.strictObject({
  scope: backofficeRoutableScopeSchema,
  path: z.string().startsWith("/workspace/").max(1_100),
  filename: z.string().min(1).max(500),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  contentType: z.string().min(1).max(240),
});

export type GeneratedUiUploadedFile = z.infer<typeof generatedUiUploadedFileSchema>;

/** Generated UI may upload to the current scope, the user's own, or its organization's scopes. */
export function resolveGeneratedUiUploadScope(
  scope: GeneratedUiUploadScope,
  currentScope: BackofficeRoutableScope | undefined,
): BackofficeRoutableScope {
  if (scope.kind === "current") {
    if (!currentScope) {
      throw new Error("The current Backoffice context does not support private file uploads.");
    }
    return currentScope;
  }
  if (scope.kind === "user") {
    return scope;
  }
  const organization = currentScope && backofficeScopeOrganization(currentScope);
  if (!organization || organization.orgId !== backofficeScopeOrganization(scope)?.orgId) {
    throw new Error("Generated UI uploads cannot target another organization.");
  }
  return scope;
}
