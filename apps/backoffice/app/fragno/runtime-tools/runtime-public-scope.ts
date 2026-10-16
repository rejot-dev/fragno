import {
  type BackofficeContextScope,
  backofficeScopeOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import { backofficePublicScopeFromRuntimeScope } from "@/backoffice-runtime/resolved-scope";
import { backofficePublicScopePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";

/** Resolves an ID-backed organization to the identity public routes address it by. */
export async function resolveRuntimeOrganization(
  runtime: Pick<BackofficeRuntimeServices, "objects">,
  organizationId: string,
) {
  const organization = (await runtime.objects.auth.singleton().commands.getAllOrganizations()).find(
    ({ id }) => id === organizationId,
  );
  if (!organization) {
    throw new BackofficeOperationError(
      "not_found",
      `Organization '${organizationId}' could not be found.`,
    );
  }
  return { id: organization.id, slug: organization.slug };
}

/** Public fragment routes address organizations by slug, while execution scopes carry only IDs. */
export async function resolveRuntimePublicScopePathSegment(
  runtime: Pick<BackofficeRuntimeServices, "objects">,
  scope: BackofficeContextScope,
  fragmentName: string,
): Promise<string> {
  if (scope.kind === "system") {
    throw new Error(`${fragmentName} public routes require a routable scope.`);
  }
  const reference = backofficeScopeOrganization(scope);
  const organization = reference
    ? await resolveRuntimeOrganization(runtime, reference.orgId)
    : null;
  return backofficePublicScopePathSegment(
    backofficePublicScopeFromRuntimeScope(scope, organization),
  );
}
