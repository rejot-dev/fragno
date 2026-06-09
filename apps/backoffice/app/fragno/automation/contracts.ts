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

export type AutomationEventActor = {
  type: string;
  externalId: string;
  [key: string]: unknown;
};

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
  actor?: AutomationEventActor | null;
  subject?: AutomationEventSubject | null;
};

export type AutomationKnownEvent<S extends AutomationSource = AutomationSource> = Omit<
  AutomationEvent,
  "source" | "eventType"
> & {
  source: S;
  eventType: AutomationEventTypeForSource<S>;
};

export type AutomationBashEnvironment = Record<string, string | undefined>;

export type AutomationCreateIdentityClaimInput = {
  orgId?: string;
  source: string;
  externalActorId: string;
  ttlMinutes?: number;
  event: AutomationEvent;
  idempotencyKey: string;
};

export type AutomationCreateIdentityClaimResult = {
  url: string;
  externalId: string;
  code: string;
  type?: string;
  expiresAt?: string;
};
