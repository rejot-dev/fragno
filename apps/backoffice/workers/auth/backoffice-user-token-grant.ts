import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { betterAuth } from "better-auth";

import type { Role } from "@/fragno/auth/contracts";

type BetterAuthAdapter = Awaited<ReturnType<typeof betterAuth>["$context"]>["adapter"];

/** User authority is shared by browser session and first-party OAuth token issuance. */
export type BackofficeUserTokenGrantResolution =
  | {
      status: "ready";
      authority: {
        userId: string;
        email: string;
        globalRole: Role;
        scope: BackofficeContextScope;
        organization: { id: string; slug: string; roles: string[] } | null;
      };
    }
  | { status: "organization_provisioning"; retryAfterMs: number };

/** Reports live user or membership state that forbids a requested token grant. */
export class BackofficeUserTokenGrantForbiddenError extends Error {
  override readonly name = "BackofficeUserTokenGrantForbiddenError";
}

/** Resolves current user authority; it does not confer installed-app authority. */
export type ResolveBackofficeUserTokenGrant = (
  adapter: BetterAuthAdapter,
  input: {
    userId: string;
    scope: BackofficeContextScope | null;
    organizationSelection: "preferred" | "required";
  },
) => Promise<BackofficeUserTokenGrantResolution>;
