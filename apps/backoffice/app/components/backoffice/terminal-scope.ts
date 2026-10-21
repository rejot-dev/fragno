import {
  backofficeResolvedScopeId,
  backofficeRouteScopeFromResolvedScope,
  type BackofficeResolvedScope,
  type BackofficeScopeSelection,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopePath } from "@/backoffice-runtime/route-scope";
import type { BackofficeMeData } from "@/fragno/auth/contracts";
import type { DashboardTerminalScope } from "@/routes/backoffice/dashboard-terminal";

import { backofficeScopeOptions } from "./scope-options";

/** A scope the terminal can run in, under the heading the scope menu lists it. */
export type TerminalScope = DashboardTerminalScope & {
  group: "This page" | "System" | "Organizations" | "Personal";
};

/**
 * The scopes the terminal can switch to: the user's scopes, plus the page's own scope when it is
 * one they cannot pick elsewhere, such as a project.
 */
export function terminalScopes(
  me: BackofficeMeData | null,
  pageScope: BackofficeScopeSelection,
): { page: TerminalScope; all: TerminalScope[] } {
  const options = (me ? backofficeScopeOptions(me) : []).map((option) =>
    terminalScope({ ...option.scope, label: option.label }, me),
  );
  const page =
    options.find((scope) => scope.id === backofficeResolvedScopeId(pageScope)) ??
    terminalScope(pageScope, me);
  return { page, all: options.includes(page) ? options : [page, ...options] };
}

function terminalScope(
  selection: BackofficeScopeSelection,
  me: BackofficeMeData | null,
): TerminalScope {
  return {
    id: backofficeResolvedScopeId(selection),
    name: useName(selection, me),
    label: selection.label,
    actionPath: `/backoffice/terminal/${backofficeRouteScopePath(backofficeRouteScopeFromResolvedScope(selection))}`,
    group: scopeGroup(selection),
  };
}

/** What `use` calls a scope: organizations by slug, so `use acme` reads like the URL. */
function useName(scope: BackofficeResolvedScope, me: BackofficeMeData | null): string {
  switch (scope.kind) {
    case "system":
      return "system";
    case "org":
      return scope.organization.slug;
    case "user":
      return scope.userId === me?.user.id ? "personal" : scope.userId;
    case "project":
      return `${useName(scope.owner, me)}/${scope.project.slug}`;
    case "app":
      return `${useName(scope.owner, me)}/${scope.appId}`;
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
}

function scopeGroup(scope: BackofficeResolvedScope): TerminalScope["group"] {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org":
      return "Organizations";
    case "user":
      return "Personal";
    case "project":
    case "app":
      return "This page";
    default:
      throw new Error("Unsupported Backoffice scope kind.", { cause: scope satisfies never });
  }
}
