import { z } from "zod";

import type { Role } from "@/fragno/auth/contracts";
import { AUTOMATION_SYSTEM_INITIATOR, type AutomationActors } from "@/fragno/automation/actors";

import type { BackofficeInternalServiceAuthorityRole } from "./authority-roles";

export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

export const backofficeContextScopeLabel = (scope: BackofficeContextScope): string => {
  switch (scope.kind) {
    case "system":
      return "System";
    case "org":
      return scope.orgId;
    case "user":
      return scope.userId;
    case "project":
      return `${scope.orgId} / ${scope.projectId}`;
  }

  throw new Error("Unsupported Backoffice context scope kind.");
};

export const backofficeContextScopesEqual = (
  left: BackofficeContextScope,
  right: BackofficeContextScope,
): boolean => {
  switch (left.kind) {
    case "system":
      return right.kind === "system";
    case "org":
      return right.kind === "org" && left.orgId === right.orgId;
    case "user":
      return right.kind === "user" && left.userId === right.userId;
    case "project":
      return (
        right.kind === "project" && left.orgId === right.orgId && left.projectId === right.projectId
      );
  }

  throw new Error("Unsupported Backoffice context scope kind.");
};

/** Short-lived user authority established by authenticating a Backoffice JWT request. */
export type BackofficeVerifiedRequestAuthority = Readonly<{
  kind: "verified-request-authority";
  userId: string;
  role: Role;
  organizationId: string | null;
  expiresAtEpochMs: number;
}>;

export const backofficeVerifiedRequestAuthoritySchema: z.ZodType<BackofficeVerifiedRequestAuthority> =
  z.strictObject({
    kind: z.literal("verified-request-authority"),
    userId: z.string().trim().min(1),
    role: z.enum(["user", "admin"]),
    organizationId: z.string().trim().min(1).nullable(),
    expiresAtEpochMs: z.number().int().positive(),
  });

export type BackofficeExecutionContext = {
  scope: BackofficeContextScope;
  actors: AutomationActors;
  /**
   * Verified request authority, kept separate from actor provenance and never persisted in events.
   * Deferred executions omit it and resolve current authority from Auth instead.
   */
  userAuthority?: BackofficeVerifiedRequestAuthority;
};

export const BACKOFFICE_SYSTEM_ACTORS = {
  initiator: AUTOMATION_SYSTEM_INITIATOR,
  principal: null,
  delegation: [],
} as const satisfies AutomationActors;

const BACKOFFICE_INTERACTIVE_INITIATOR = {
  scope: "internal",
  type: "backoffice",
  id: "interactive",
  role: "initiator",
} as const satisfies AutomationActors["initiator"];

/** Creates trusted provenance for an authenticated Backoffice user request. */
export const createBackofficeUserExecution = ({
  scope,
  userId,
  verifiedRequestAuthority,
}: {
  scope: BackofficeContextScope;
  userId: string;
  verifiedRequestAuthority?: Readonly<{
    role: Role;
    organizationId: string | null;
    expiresAt: Date;
  }>;
}): BackofficeExecutionContext => ({
  scope,
  actors: {
    initiator: BACKOFFICE_INTERACTIVE_INITIATOR,
    principal: {
      scope: "internal",
      type: "user",
      id: userId,
      role: "principal",
    },
    delegation: [],
  },
  ...(verifiedRequestAuthority
    ? {
        userAuthority: {
          kind: "verified-request-authority" as const,
          userId,
          role: verifiedRequestAuthority.role,
          organizationId: verifiedRequestAuthority.organizationId,
          expiresAtEpochMs: verifiedRequestAuthority.expiresAt.getTime(),
        },
      }
    : {}),
});

/** Creates principal-free provenance for a trusted Backoffice system operation. */
export const createBackofficeSystemExecution = (
  scope: BackofficeContextScope,
): BackofficeExecutionContext => ({
  scope,
  actors: BACKOFFICE_SYSTEM_ACTORS,
});

/** Creates trusted provenance for an internal service operating as the current principal. */
export const createBackofficeServiceExecution = ({
  scope,
  service,
}: {
  scope: BackofficeContextScope;
  service: { type: BackofficeInternalServiceAuthorityRole; id: string };
}): BackofficeExecutionContext => ({
  scope,
  actors: {
    initiator: AUTOMATION_SYSTEM_INITIATOR,
    principal: {
      scope: "internal",
      type: service.type,
      id: service.id,
      role: "principal",
    },
    delegation: [],
  },
});
