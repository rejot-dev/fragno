import { createContext, type RouterContext, type RouterContextProvider } from "react-router";

import type {
  BackofficeOrganizationIdentity,
  BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeAuthPrincipal, BackofficeMeData } from "@/fragno/auth/contracts";
import type { BackofficeJwtPayload } from "@/fragno/auth/token-lifecycle";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

/** Identifies why a Backoffice request credential could not establish authentication. */
export type BackofficeAuthenticationFailureReason = "missing" | "expired" | "invalid";

/** Carries the canonical token verification result shared by one Backoffice HTTP request. */
export type BackofficeAuthenticationResult =
  | {
      ok: true;
      transport: "bearer" | "cookie";
      payload: BackofficeJwtPayload;
      headers: Array<[string, string]>;
    }
  | {
      ok: false;
      reason: BackofficeAuthenticationFailureReason;
      headers: Array<[string, string]>;
    };

/** Carries the canonical authenticated principal shared by one Backoffice HTTP request. */
export type BackofficePrincipalResult =
  | { ok: true; principal: BackofficeAuthPrincipal; headers: Array<[string, string]> }
  | {
      ok: false;
      reason: BackofficeAuthenticationFailureReason;
      headers: Array<[string, string]>;
    };

/** Describes the membership snapshot resolved from a Backoffice request credential. */
export type BackofficeMeLookupResult =
  | { status: "missing" }
  | { status: "invalid"; reason: "expired" | "invalid" }
  | { status: "authenticated"; me: BackofficeMeData; expiresAt: Date };

/** Exposes named authoritative operations coalesced within one Backoffice HTTP request. */
export type BackofficeRequestState = {
  resolveAuthentication(): Promise<BackofficeAuthenticationResult>;
  getPrincipal(): Promise<BackofficePrincipalResult>;
  getBackofficeMe(): Promise<BackofficeMeLookupResult>;
  getAutomationCollectionSource<TOrganization extends BackofficeOrganizationIdentity>(
    resolvedScope: BackofficeResolvedScope<TOrganization>,
  ): Promise<AutomationCollectionSource<TOrganization>>;
};

const backofficeRequestStateContextKey = Symbol.for("fragno.backoffice.request-state-context");

/** Provides one request-scoped set of authoritative Backoffice server operations. */
export const BackofficeRequestStateContext = ((globalThis as Record<symbol, unknown>)[
  backofficeRequestStateContextKey
] ??= createContext<BackofficeRequestState>()) as RouterContext<BackofficeRequestState>;

/** Reads the authoritative Backoffice operations installed for the current HTTP request. */
export function getBackofficeRequestState(
  context: Readonly<RouterContextProvider>,
): BackofficeRequestState {
  return context.get(BackofficeRequestStateContext);
}
