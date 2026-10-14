// identity tools
type IdentityCodemodeProvider = {
  /** Resolve an active external identity binding so the workflow can choose its internal user. */
  resolveExternal(input: IdentityResolveExternalInput): Promise<IdentityResolveExternalOutput>;
  /** List external identities bound to users in the current scope, active and revoked, ordered by source, type, and id. */
  listExternal(input: IdentityListExternalInput): Promise<IdentityListExternalOutput>;
};
declare const identity: IdentityCodemodeProvider;

type IdentityResolveExternalInput = {
  source: string;
  type: string;
  id: string;
};
type IdentityResolveExternalOutput = {
  userId: string;
} | null;
type IdentityListExternalInput = {
  limit?: number;
  cursor?: string;
};
type IdentityListExternalOutput = {
  bindings: {
    id: string;
    source: string;
    type: string;
    externalId: string;
    userId: string;
    verifiedByClaimId: string;
    status: "active" | "revoked";
    /** ISO 8601 datetime string. */
    boundAt: string;
    revokedAt: string | null;
  }[];
  nextCursor: string | null;
};
