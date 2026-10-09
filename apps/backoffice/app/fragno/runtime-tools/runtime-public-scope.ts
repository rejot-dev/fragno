import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  backofficeRouteScopeFromResolvedScope,
  resolveBackofficeRuntimeScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
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
    throw new Error(`Organization '${organizationId}' could not be found.`);
  }
  return { id: organization.id, slug: organization.slug };
}

/** Public fragment routes address organizations by slug, while execution scopes carry only IDs. */
export async function resolveRuntimePublicScopePathSegment(
  runtime: Pick<BackofficeRuntimeServices, "objects">,
  scope: BackofficeContextScope,
  fragmentName: string,
): Promise<string> {
  const resolvedScope = await resolveBackofficeRuntimeScope(scope, (organizationId) =>
    resolveRuntimeOrganization(runtime, organizationId),
  );
  if (resolvedScope.kind === "system") {
    throw new Error(`${fragmentName} public routes require a routable scope.`);
  }
  return backofficeRouteScopeSinglePathSegment(
    backofficeRouteScopeFromResolvedScope(resolvedScope),
  );
}
