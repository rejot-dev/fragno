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
};
