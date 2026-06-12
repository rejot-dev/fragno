import {
  AUTOMATION_SOURCES,
  AUTOMATION_SOURCE_EVENT_TYPES,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type {
  AutomationEventTypeForSource,
  AutomationKnownEventType,
  AutomationSource,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES };
export type { AutomationKnownEventType, AutomationEventTypeForSource, AutomationSource };

export type AutomationEventPayload = Record<string, unknown>;

export type AutomationEntityScope = "internal" | "external";

export type AutomationEntityDefinition<
  TScope extends AutomationEntityScope = AutomationEntityScope,
  TType extends string = string,
> = {
  scope: TScope;
  type: TType;
  label: string;
  description?: string;
};

export type AutomationInternalEntityDefinition<TType extends string = string> =
  AutomationEntityDefinition<"internal", TType> & {
    idField: string;
  };

export type AutomationExternalEntityDefinition<
  TSource extends string = string,
  TType extends string = string,
> = AutomationEntityDefinition<"external", TType> & {
  source: TSource;
};

export type AutomationEntityRef<
  TScope extends AutomationEntityScope = AutomationEntityScope,
  TType extends string = string,
> = {
  scope: TScope;
  type: TType;
  id: string;
  source?: string;
  [key: string]: unknown;
};

export type AutomationExternalEntityRef<
  TSource extends string = string,
  TType extends string = string,
> = AutomationEntityRef<"external", TType> & {
  source: TSource;
};

export const AUTOMATION_INTERNAL_ENTITIES = {
  org: {
    scope: "internal",
    type: "org",
    label: "Organisation",
    description: "Backoffice organisation.",
    idField: "orgId",
  },
  user: {
    scope: "internal",
    type: "user",
    label: "User",
    description: "Backoffice user.",
    idField: "userId",
  },
  capability: {
    scope: "internal",
    type: "capability",
    label: "Capability",
    description: "Backoffice capability or connection.",
    idField: "capabilityId",
  },
} as const satisfies Record<string, AutomationInternalEntityDefinition>;

export type AutomationInternalEntityType = keyof typeof AUTOMATION_INTERNAL_ENTITIES;

export type AutomationEventActor = AutomationEntityRef & {
  role?: "initiator" | "principal" | "delegate" | "system" | string;
};
export type AutomationEventActors = AutomationEventActor[];

export const AUTOMATION_SYSTEM_ACTOR = {
  scope: "internal",
  type: "system",
  id: "backoffice",
  role: "system",
} as const satisfies AutomationEventActor;

export type AutomationEventSubject = {
  orgId?: string;
  userId?: string;
  [key: string]: unknown;
};

export type AutomationEvent = {
  id: string;
  orgId?: string;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: AutomationEventPayload;
  actor: AutomationEventActor;
  actors: AutomationEventActors;
  subject?: AutomationEventSubject | null;
};

export type AutomationKnownEvent<S extends AutomationSource = AutomationSource> = Omit<
  AutomationEvent,
  "source" | "eventType"
> & {
  source: S;
  eventType: AutomationEventTypeForSource<S>;
};

export type AutomationCreateIdentityClaimInput = {
  orgId?: string;
  actor: AutomationEventActor;
  ttlMinutes?: number;
  event: AutomationEvent;
  idempotencyKey: string;
};

export type AutomationCreateIdentityClaimResult = {
  url: string;
  externalId: string;
  code: string;
  actor: AutomationEventActor;
  type?: string;
  expiresAt?: string;
};
