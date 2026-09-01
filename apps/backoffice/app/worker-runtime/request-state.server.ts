import type { AuthObject, FetchObject } from "@/backoffice-runtime/object-registry";
import {
  backofficeResolvedScopeId,
  type BackofficeOrganizationIdentity,
  type BackofficeResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeMeDataSchema, type BackofficeAuthPrincipal } from "@/fragno/auth/contracts";
import {
  resolveBackofficeJwtTransport,
  type ResolvedBackofficeJwtTransport,
} from "@/fragno/auth/jwt-transport";
import {
  expiredBackofficeAccessTokenCookieHeaders,
  type BackofficeJwtPayload,
  type BackofficeJwtVerificationResult,
} from "@/fragno/auth/token-lifecycle";
import type { AutomationCollectionSource } from "@/fragno/automation/tanstack/browser-database";

import type {
  BackofficeAuthenticationResult,
  BackofficeMeLookupResult,
  BackofficePrincipalResult,
  BackofficeRequestState,
} from "./request-state";

type BackofficeRequestAuthObject = {
  http: FetchObject;
  commands: Pick<AuthObject, "getBackofficeMe">;
};

/** Supplies the concrete authentication authority used by a Backoffice request state. */
export type BackofficeRequestStateDependencies = {
  getAuthObject(): BackofficeRequestAuthObject;
  verifyJwt(
    token: string | null,
    requestUrl: string,
    authObject: FetchObject,
  ): Promise<BackofficeJwtVerificationResult>;
  loadAutomationCollectionSource<TOrganization extends BackofficeOrganizationIdentity>(
    resolvedScope: BackofficeResolvedScope<TOrganization>,
  ): Promise<AutomationCollectionSource<TOrganization>>;
};

function principalFromBackofficeJwt(
  payload: BackofficeJwtPayload,
  transport: "bearer" | "cookie",
): BackofficeAuthPrincipal {
  return {
    user: { id: payload.sub, email: payload.email, role: payload.globalRole },
    auth: {
      transport,
      expiresAt: new Date(payload.exp * 1_000),
      organization: payload.organization,
    },
  };
}

function authenticationFailureHeaders(
  transport: ResolvedBackofficeJwtTransport,
): Array<[string, string]> {
  if (!transport.ok || transport.transport !== "cookie") {
    return [];
  }
  return expiredBackofficeAccessTokenCookieHeaders().map((value) => ["Set-Cookie", value]);
}

/** Creates lazy authentication and membership operations shared for one HTTP request only. */
export function createBackofficeRequestState(
  request: Request,
  dependencies: BackofficeRequestStateDependencies,
): BackofficeRequestState {
  let authObject: BackofficeRequestAuthObject | null = null;
  let authenticationPromise: Promise<BackofficeAuthenticationResult> | null = null;
  let principalPromise: Promise<BackofficePrincipalResult> | null = null;
  let backofficeMePromise: Promise<BackofficeMeLookupResult> | null = null;
  const automationCollectionSourcePromises = new Map<string, Promise<AutomationCollectionSource>>();

  function getAuthObject(): BackofficeRequestAuthObject {
    authObject ??= dependencies.getAuthObject();
    return authObject;
  }

  async function resolveAuthenticationOperation(): Promise<BackofficeAuthenticationResult> {
    const transport = resolveBackofficeJwtTransport(request);
    if (!transport.ok) {
      return { ...transport, headers: [] };
    }

    const verification = await dependencies.verifyJwt(
      transport.token,
      request.url,
      getAuthObject().http,
    );
    if (!verification.ok) {
      return {
        ok: false,
        reason: verification.reason,
        headers: authenticationFailureHeaders(transport),
      };
    }

    return {
      ok: true,
      transport: transport.transport,
      payload: verification.payload,
      headers: [],
    };
  }

  function resolveAuthentication(): Promise<BackofficeAuthenticationResult> {
    authenticationPromise ??= resolveAuthenticationOperation();
    return authenticationPromise;
  }

  async function getPrincipalOperation(): Promise<BackofficePrincipalResult> {
    const authentication = await resolveAuthentication();
    return authentication.ok
      ? {
          ok: true,
          principal: principalFromBackofficeJwt(authentication.payload, authentication.transport),
          headers: authentication.headers,
        }
      : authentication;
  }

  function getPrincipal(): Promise<BackofficePrincipalResult> {
    principalPromise ??= getPrincipalOperation();
    return principalPromise;
  }

  async function getBackofficeMeOperation(): Promise<BackofficeMeLookupResult> {
    const authentication = await resolveAuthentication();
    if (!authentication.ok) {
      return authentication.reason === "missing"
        ? { status: "missing" }
        : { status: "invalid", reason: authentication.reason };
    }

    const me = await getAuthObject().commands.getBackofficeMe({
      userId: authentication.payload.sub,
      activeOrganizationId: authentication.payload.organization?.id ?? null,
    });
    return me
      ? {
          status: "authenticated",
          me: backofficeMeDataSchema.parse(me),
          expiresAt: new Date(authentication.payload.exp * 1_000),
        }
      : { status: "invalid", reason: "invalid" };
  }

  function getBackofficeMe(): Promise<BackofficeMeLookupResult> {
    backofficeMePromise ??= getBackofficeMeOperation();
    return backofficeMePromise;
  }

  function getAutomationCollectionSource<TOrganization extends BackofficeOrganizationIdentity>(
    resolvedScope: BackofficeResolvedScope<TOrganization>,
  ): Promise<AutomationCollectionSource<TOrganization>> {
    const operationKey = backofficeResolvedScopeId(resolvedScope);
    let sourcePromise = automationCollectionSourcePromises.get(operationKey);
    if (!sourcePromise) {
      sourcePromise = dependencies.loadAutomationCollectionSource(resolvedScope);
      automationCollectionSourcePromises.set(operationKey, sourcePromise);
    }
    return sourcePromise as Promise<AutomationCollectionSource<TOrganization>>;
  }

  return {
    resolveAuthentication,
    getPrincipal,
    getBackofficeMe,
    getAutomationCollectionSource,
  };
}
