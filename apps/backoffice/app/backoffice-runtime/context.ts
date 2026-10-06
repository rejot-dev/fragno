import { z } from "zod";

import type { Role } from "@/fragno/auth/contracts";
import {
  automationActorsSchema,
  AUTOMATION_SYSTEM_INITIATOR,
  type AutomationActors,
} from "@/fragno/automation/actors";

import type { BackofficeInternalServiceAuthorityRole } from "./authority-roles";

export type BackofficeContextScope =
  | { kind: "system" }
  | { kind: "org"; orgId: string }
  | { kind: "user"; userId: string }
  | { kind: "project"; orgId: string; projectId: string };

/** Validates a serialized Backoffice execution scope at an HTTP or storage boundary. */
export const backofficeContextScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("system") }),
  z.strictObject({ kind: z.literal("org"), orgId: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal("user"), userId: z.string().trim().min(1) }),
  z.strictObject({
    kind: z.literal("project"),
    orgId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
  }),
]) satisfies z.ZodType<BackofficeContextScope>;

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
  scopeRestriction: BackofficeContextScope | null;
}>;

export const backofficeVerifiedRequestAuthoritySchema: z.ZodType<BackofficeVerifiedRequestAuthority> =
  z.strictObject({
    kind: z.literal("verified-request-authority"),
    userId: z.string().trim().min(1),
    role: z.enum(["user", "admin"]),
    organizationId: z.string().trim().min(1).nullable(),
    expiresAtEpochMs: z.number().int().positive(),
    scopeRestriction: backofficeContextScopeSchema.nullable(),
  });

/** Deferred execution persists provenance, never a request's authority snapshot. */
export type BackofficeDeferredExecution = {
  kind: "deferred";
  scope: BackofficeContextScope;
  scopeRestriction: BackofficeContextScope | null;
  actors: AutomationActors;
};

/** Request authority is required and cannot be combined with delegated actors. */
export type BackofficeRequestExecution = {
  kind: "request";
  scope: BackofficeContextScope;
  actors: AutomationActors & {
    principal: { scope: "internal"; type: "user"; id: string; role: "principal" };
    delegation: [];
  };
  userAuthority: BackofficeVerifiedRequestAuthority;
};

export type BackofficeExecutionContext = BackofficeRequestExecution | BackofficeDeferredExecution;

/** Deferred execution retains scope ceilings and provenance, never request authority. */
export const backofficeDeferredExecutionSchema = z.strictObject({
  kind: z.literal("deferred"),
  scope: backofficeContextScopeSchema,
  scopeRestriction: backofficeContextScopeSchema.nullable(),
  actors: automationActorsSchema,
}) satisfies z.ZodType<BackofficeDeferredExecution>;

/** Validates execution variants when crossing a serialized trust boundary. */
export const backofficeExecutionContextSchema: z.ZodType<BackofficeExecutionContext> =
  z.discriminatedUnion("kind", [
    backofficeDeferredExecutionSchema,
    z.strictObject({
      kind: z.literal("request"),
      scope: backofficeContextScopeSchema,
      actors: automationActorsSchema.and(
        z.object({
          principal: z.strictObject({
            scope: z.literal("internal"),
            type: z.literal("user"),
            id: z.string().min(1),
            role: z.literal("principal"),
          }),
          delegation: z.tuple([]),
        }),
      ),
      userAuthority: backofficeVerifiedRequestAuthoritySchema,
    }),
  ]);

/** Scope ceilings survive deferral even though request snapshots and token expiry do not. */
export function backofficeExecutionScopeRestriction(
  execution: BackofficeExecutionContext,
): BackofficeContextScope | null {
  return execution.kind === "request"
    ? execution.userAuthority.scopeRestriction
    : execution.scopeRestriction;
}

/** Scheduling retains the caller's scope ceiling, but resolves user and delegate permissions live. */
export function deferBackofficeExecution(
  execution: BackofficeExecutionContext,
): BackofficeDeferredExecution {
  return {
    kind: "deferred",
    scope: execution.scope,
    actors: execution.actors,
    scopeRestriction: backofficeExecutionScopeRestriction(execution),
  };
}

/** A credential scope is an upper bound, not a selected organization or navigation preference. */
export function backofficeScopeContains(
  restriction: BackofficeContextScope,
  target: BackofficeContextScope,
): boolean {
  return (
    backofficeContextScopesEqual(restriction, target) ||
    (restriction.kind === "org" && target.kind === "project" && restriction.orgId === target.orgId)
  );
}

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

/** Names a user for deferred work; permissions are resolved from current identity state. */
export function createBackofficeUserExecution({
  scope,
  userId,
}: {
  scope: BackofficeContextScope;
  userId: string;
}): BackofficeDeferredExecution {
  return {
    kind: "deferred",
    scope,
    scopeRestriction: null,
    actors: {
      initiator: BACKOFFICE_INTERACTIVE_INITIATOR,
      principal: { scope: "internal", type: "user", id: userId, role: "principal" },
      delegation: [],
    },
  };
}

/** Only authentication boundaries may construct a verified request execution. */
export function createBackofficeRequestExecution({
  scope,
  userId,
  verifiedRequestAuthority,
}: {
  scope: BackofficeContextScope;
  userId: string;
  verifiedRequestAuthority: Readonly<{
    role: Role;
    organizationId: string | null;
    expiresAt: Date;
    scopeRestriction: BackofficeContextScope | null;
  }>;
}): BackofficeRequestExecution {
  return {
    kind: "request",
    scope,
    actors: {
      initiator: BACKOFFICE_INTERACTIVE_INITIATOR,
      principal: { scope: "internal", type: "user", id: userId, role: "principal" },
      delegation: [],
    },
    userAuthority: {
      kind: "verified-request-authority",
      userId,
      role: verifiedRequestAuthority.role,
      organizationId: verifiedRequestAuthority.organizationId,
      expiresAtEpochMs: verifiedRequestAuthority.expiresAt.getTime(),
      scopeRestriction: verifiedRequestAuthority.scopeRestriction,
    },
  };
}

/** Creates principal-free provenance for a trusted Backoffice system operation. */
export const createBackofficeSystemExecution = (
  scope: BackofficeContextScope,
): BackofficeDeferredExecution => ({
  kind: "deferred",
  scope,
  scopeRestriction: null,
  actors: BACKOFFICE_SYSTEM_ACTORS,
});

/** Creates trusted provenance for an internal service operating as the current principal. */
export const createBackofficeServiceExecution = ({
  scope,
  service,
}: {
  scope: BackofficeContextScope;
  service: { type: BackofficeInternalServiceAuthorityRole; id: string };
}): BackofficeDeferredExecution => ({
  kind: "deferred",
  scope,
  scopeRestriction: null,
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
