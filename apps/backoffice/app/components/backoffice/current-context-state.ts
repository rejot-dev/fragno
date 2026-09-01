import type {
  BackofficeOrganizationIdentity,
  BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { Organization } from "@/fragno/auth/contracts";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

export type AutomationCollectionSourceState<
  TOrganization extends BackofficeOrganizationIdentity = BackofficeOrganizationIdentity,
> =
  | { status: "ready"; source: AutomationCollectionSource<TOrganization> }
  | {
      status: "unavailable";
      resolvedScope: BackofficeResolvedScope<TOrganization>;
      message: string;
    };

export type CurrentBackofficeContext = {
  resolvedScope: BackofficeResolvedScope<Organization>;
  automationCollectionSource: AutomationCollectionSourceState<Organization>;
  projectCollectionSource: AutomationCollectionSourceState<Organization> | null;
};
