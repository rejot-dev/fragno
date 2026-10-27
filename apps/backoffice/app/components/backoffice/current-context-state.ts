import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type {
  BackofficeOrganizationIdentity,
  BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { Organization } from "@/fragno/auth/contracts";
import type { AutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";

export type AutomationReplicaSourceState<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> =
  | { status: "ready"; source: AutomationReplicaSource<TOrganization> }
  | {
      status: "unavailable";
      resolvedScope: BackofficeResolvedScope<TOrganization>;
      message: string;
    };

export type CurrentBackofficeContext = {
  resolvedScope: BackofficeResolvedScope<Organization>;
  automationReplicaSource: AutomationReplicaSourceState<Organization>;
  /**
   * Names another scope as this page's links need it, such as one an agent's work ran in: the
   * page's own scope, the viewer's organizations, or a personal scope. Null when the page does not
   * know the scope's slugs, such as another owner's project.
   */
  resolveScope: (scope: BackofficeContextScope) => BackofficeResolvedScope<Organization> | null;
};
