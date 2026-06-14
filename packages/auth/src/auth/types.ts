import type { Role } from "../types";

export type AuthStrategyName = "session";
export type AuthCredentialKind = "session" | "jwt";
export type AuthCredentialSource = "cookie" | "authorization-header";
export type RequestAuthFailureReason = "missing" | "malformed" | "multiple" | "invalid";

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
    sessionContext?: unknown;
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
  refreshToken?: string;
  refreshExpiresAt?: Date | null;
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
      reason: Extract<RequestAuthFailureReason, "missing" | "malformed" | "multiple">;
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
  sessionContext?: unknown;
  organizationIds?: string[];
}

export interface CreatedCredential {
  id: string;
  expiresAt: Date;
  activeOrganizationId: string | null;
}
