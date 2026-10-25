import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";

import {
  backofficeRuntimeScopeFromResolvedScope,
  type BackofficeOrganizationIdentity,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeContextScopeRoutePath } from "@/backoffice-runtime/scope-codec";

/**
 * The scope whose Automations data a page replicates, with the identity of the backend that holds
 * it, which the server describes for each request.
 */
export type AutomationReplicaSource<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> = {
  resolvedScope: BackofficeResolvedScope<TOrganization>;
  adapterIdentity: string;
};

type AutomationReplicaSourceDescription = {
  /** Names the replica: one per scope and backend. */
  resourceKey: string;
  /** Where the scope's outbox is served, below which `/_internal` describes it. */
  baseUrl: string;
  internalUrl: string;
};

export function describeAutomationReplicaSource(
  source: AutomationReplicaSource,
): AutomationReplicaSourceDescription {
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(source.resolvedScope);
  const scopeKey = backofficeScopePathSegment(runtimeScope);
  const baseUrl = `/api/automations-scoped/${backofficeContextScopeRoutePath(runtimeScope)}`;

  return {
    resourceKey: JSON.stringify([scopeKey, source.adapterIdentity]),
    baseUrl,
    internalUrl: `${baseUrl}/_internal`,
  };
}
