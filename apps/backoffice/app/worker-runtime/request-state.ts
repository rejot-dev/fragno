import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { createContext, type RouterContext, type RouterContextProvider } from "react-router";

import type {
  BackofficeOrganizationIdentity,
  BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { BackofficeAuthPrincipal, BackofficeMeData } from "@/fragno/auth/contracts";
import type { BackofficeJwtPayload } from "@/fragno/auth/token-lifecycle";
import type { AutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";
import type { FeatureFlagKey } from "@/fragno/feature-flags/definitions";
import type { OverrideStatus } from "@/fragno/overrides/resolve";

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
  getAutomationReplicaSource<TOrganization extends BackofficeOrganizationIdentity>(
    resolvedScope: BackofficeResolvedScope<TOrganization>,
  ): Promise<AutomationReplicaSource<TOrganization>>;
  /** Overrides are read once per scope, so the shell and the page share the read. */
  getFeatureFlag(
    scope: BackofficeContextScope,
    key: FeatureFlagKey,
  ): Promise<OverrideStatus<boolean>>;
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
