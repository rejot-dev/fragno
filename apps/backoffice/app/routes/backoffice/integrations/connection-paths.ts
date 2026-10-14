import {
  backofficeRouteScopeFromResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";

export const integrationsScopeBasePath = (scope: BackofficeScopeSelection): string =>
  `/backoffice/integrations/${backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(scope))}`;

export const integrationConnectionPath = (scope: BackofficeScopeSelection, connectionId: string) =>
  `${integrationsScopeBasePath(scope)}/${encodeURIComponent(connectionId)}`;
