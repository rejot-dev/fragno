import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

/** A member's latest Backoffice activity, as the other members of their room see it. */
export type PresenceMember = {
  userId: string;
  email: string;
  /** The page they last requested, or null while they work outside the room's organization. */
  path: string | null;
  lastActiveAt: string;
};

/** One authenticated Backoffice page request, recorded in its user's presence room. */
export type PresenceActivity = {
  user: { id: string; email: string };
  path: string | null;
  /** The scope the page works in; it decides warming and is never shown to other members. */
  scope: BackofficeContextScope;
};

export type PresenceActivityResult = {
  /** True on the user's first activity in the window, or when it moves them to another scope. */
  enteredScope: boolean;
};
