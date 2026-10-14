import {
  backofficeRouteScopePath,
  type BackofficeRouteScope,
} from "@/backoffice-runtime/route-scope";

function computersScopePath(scope: BackofficeRouteScope): string {
  return `/backoffice/computers/${backofficeRouteScopePath(scope)}`;
}

export function sandboxesPath(scope: BackofficeRouteScope): string {
  return `${computersScopePath(scope)}/sandboxes`;
}

export function newSandboxPath(scope: BackofficeRouteScope): string {
  return `${sandboxesPath(scope)}/new`;
}

export function sandboxPath(scope: BackofficeRouteScope, sandboxId: string): string {
  return `${sandboxesPath(scope)}/${encodeURIComponent(sandboxId)}`;
}
