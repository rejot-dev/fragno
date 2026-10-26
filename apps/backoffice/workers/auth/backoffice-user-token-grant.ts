import type {
  BackofficeContextScope,
  BackofficeUserContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { betterAuth } from "better-auth";

import type { BackofficeTokenOrganization, Role } from "@/fragno/auth/contracts";

type BetterAuthAdapter = Awaited<ReturnType<typeof betterAuth>["$context"]>["adapter"];

/** User authority is shared by browser session and first-party OAuth token issuance. */
export type BackofficeUserTokenAuthority = {
  userId: string;
  email: string;
  globalRole: Role;
  personalScope: BackofficeUserContextScope | null;
  /** Null for someone with no organization who has not finished onboarding: there is nowhere yet. */
  scope: BackofficeContextScope | null;
  organization: BackofficeTokenOrganization | null;
};

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
) => Promise<BackofficeUserTokenAuthority>;
