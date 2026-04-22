import type { Role } from "../types";

export type AuthStrategyName = "session" | "stateless-jwt";
export type AuthCredentialKind = "session" | "jwt";
export type AuthCredentialSource = "cookie" | "authorization-header";
export type RequestAuthFailureReason = "missing" | "malformed" | "invalid";

export interface AuthPrincipal {
  user: {
    id: string;
    email: string;
    role: Role;
  };
  auth: {
    strategy: AuthStrategyName;
    credentialKind: AuthCredentialKind;
    credentialSource: AuthCredentialSource;
    credentialId: string | null;
    expiresAt: Date | null;
    activeOrganizationId: string | null;
  };
}

export interface AuthActor {
  userId: string;
  email: string;
  role: Role;
  activeOrganizationId: string | null;
}

export interface IssuedAuthCredential {
  token: string;
  kind: AuthCredentialKind;
  expiresAt: Date | null;
  activeOrganizationId: string | null;
}

export interface ResolvedRequestCredential {
  token: string;
  source: AuthCredentialSource;
}

export type ResolveRequestCredentialResult =
  | {
      ok: true;
      credential: ResolvedRequestCredential;
    }
  | {
      ok: false;
      reason: Extract<RequestAuthFailureReason, "missing" | "malformed">;
    };

export type ResolveRequestAuthResult =
  | {
      ok: true;
      principal: AuthPrincipal;
    }
  | {
      ok: false;
      reason: RequestAuthFailureReason;
    };

export interface ValidatedCredential {
  id: string;
  user: {
    id: string;
    email: string;
    role: Role;
  };
  expiresAt: Date | null;
  activeOrganizationId: string | null;
}

export interface CreatedCredential {
  id: string;
  expiresAt: Date;
  activeOrganizationId: string | null;
}
