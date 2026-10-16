import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";

import { integrationsScopeBasePath } from "./connection-paths";

export type ScopedIntegrationContext = {
  scope: BackofficeContextScope;
  uiScope: BackofficeScopeSelection;
  label: string;
  basePath: string;
  integrationsPath: string;
  scopeSegment: string;
  isScopedRoute: boolean;
};

export type AuthenticatedScopedIntegrationContext = ScopedIntegrationContext & {
  me: BackofficeMeData;
};

export const integrationBasePath = (scope: BackofficeScopeSelection, integration: string) =>
  `${integrationsScopeBasePath(scope)}/${integration}`;
