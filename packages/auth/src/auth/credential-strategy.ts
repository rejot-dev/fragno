import { buildClearCookieHeader, buildSetCookieHeader, type CookieOptions } from "../utils/cookie";
import { resolveRequestCredential } from "./request-auth";
import type {
  AuthPrincipal,
  IssuedAuthCredential,
  ResolveRequestAuthResult,
  ValidatedCredential,
  CreatedCredential,
} from "./types";

export interface ResolveRequestAuthInput {
  headers: Headers;
}

export interface IssueCredentialInput {
  userId: string;
  activeOrganizationId?: string | null;
}

export interface ClearCredentialInput {
  principal?: AuthPrincipal | null;
}

export interface MaybeReissueCredentialInput {
  principal: AuthPrincipal;
  activeOrganizationId?: string | null;
}

export interface AuthCredentialStrategy {
  name: "session" | "stateless-jwt";
  resolveRequestAuth(input: ResolveRequestAuthInput): Promise<ResolveRequestAuthResult>;
  issueCredential(input: IssueCredentialInput): Promise<IssuedAuthCredential>;
  clearCredential(input: ClearCredentialInput): Promise<{ headers?: HeadersInit }>;
  maybeReissueCredential?(input: MaybeReissueCredentialInput): Promise<IssuedAuthCredential | null>;
}

interface SessionCredentialStrategyDependencies {
  cookieOptions?: CookieOptions;
  validateCredential: (credentialToken: string) => Promise<ValidatedCredential | null>;
  issueCredential: (
    userId: string,
    options?: { activeOrganizationId?: string | null },
  ) => Promise<{ ok: true; credential: CreatedCredential } | { ok: false; code: string }>;
  invalidateCredential: (credentialToken: string) => Promise<boolean>;
}

export const createSessionCredentialStrategy = (
  dependencies: SessionCredentialStrategyDependencies,
): AuthCredentialStrategy => ({
  name: "session",
  async resolveRequestAuth({ headers }) {
    const resolvedCredential = resolveRequestCredential(headers, dependencies.cookieOptions);
    if (!resolvedCredential.ok) {
      return resolvedCredential;
    }

    const session = await dependencies.validateCredential(resolvedCredential.credential.token);
    if (!session) {
      return { ok: false, reason: "invalid" };
    }

    return {
      ok: true,
      principal: {
        user: {
          id: session.user.id,
          email: session.user.email,
          role: session.user.role,
        },
        auth: {
          strategy: "session",
          credentialKind: "session",
          credentialSource: resolvedCredential.credential.source,
          credentialId: session.id,
          expiresAt: session.expiresAt,
          activeOrganizationId: session.activeOrganizationId,
        },
      },
    };
  },
  async issueCredential({ userId, activeOrganizationId }) {
    const result = await dependencies.issueCredential(userId, { activeOrganizationId });
    if (!result.ok) {
      throw new Error(`Unable to create session credential: ${result.code}`);
    }

    return {
      token: result.credential.id,
      kind: "session",
      expiresAt: result.credential.expiresAt,
      activeOrganizationId: result.credential.activeOrganizationId,
    };
  },
  async clearCredential({ principal }) {
    if (principal?.auth.credentialId) {
      await dependencies.invalidateCredential(principal.auth.credentialId);
    }

    return {
      headers: buildClearedCredentialHeaders(dependencies.cookieOptions),
    };
  },
  async maybeReissueCredential() {
    return null;
  },
});

export const buildClearedCredentialHeaders = (
  cookieOptions?: CookieOptions,
): { "Set-Cookie": string } => ({
  "Set-Cookie": buildClearCookieHeader(cookieOptions ?? {}),
});

export const buildIssuedCredentialHeaders = (
  credential: IssuedAuthCredential,
  cookieOptions?: CookieOptions,
): { "Set-Cookie": string } => ({
  "Set-Cookie": buildSetCookieHeader(credential.token, cookieOptions ?? {}),
});
