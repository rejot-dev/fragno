import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import {
  AUTOMATION_SOURCES,
  AUTOMATION_SOURCE_EVENT_TYPES,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";
import type {
  AutomationEventTypeForSource,
  AutomationSource,
} from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import type { AutomationActors, AutomationExternalEntityRef } from "./actors";

export { AUTOMATION_SOURCES, AUTOMATION_SOURCE_EVENT_TYPES };
export type { AutomationEventTypeForSource, AutomationSource };

export type AutomationEventPayload = Record<string, unknown>;

export type AutomationEntityDefinition<
  TScope extends "internal" | "external" = "internal" | "external",
  TType extends string = string,
> = {
  scope: TScope;
  type: TType;
  label: string;
  description?: string;
};

export type AutomationExternalEntityDefinition<
  TSource extends string = string,
  TType extends string = string,
> = AutomationEntityDefinition<"external", TType> & {
  source: TSource;
};

export type AutomationEventSubject = {
  orgId?: string;
  userId?: string;
  [key: string]: unknown;
};

export type AutomationEvent = {
  id: string;
  scope: BackofficeContextScope;
  source: string;
  eventType: string;
  occurredAt: string;
  payload: AutomationEventPayload;
  actors: AutomationActors;
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
  scope: BackofficeContextScope;
  actor: AutomationExternalEntityRef;
  ttlMinutes?: number;
  event: AutomationEvent;
  idempotencyKey: string;
};

export type AutomationCreateIdentityClaimResult = {
  url: string;
  externalId: string;
  code: string;
  actor: AutomationExternalEntityRef;
  type?: string;
  expiresAt?: string;
};
