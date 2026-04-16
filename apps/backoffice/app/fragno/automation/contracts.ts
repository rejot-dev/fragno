export const AUTOMATION_SOURCES = {
  telegram: "telegram",
  otp: "otp",
} as const;

export const AUTOMATION_SOURCE_EVENT_TYPES = {
  [AUTOMATION_SOURCES.telegram]: {
    messageReceived: "message.received",
  },
  [AUTOMATION_SOURCES.otp]: {
    identityClaimCompleted: "identity.claim.completed",
  },
} as const;

type ValueOf<T> = T[keyof T];

export type AutomationSource = ValueOf<typeof AUTOMATION_SOURCES>;

export type AutomationEventTypeForSource<S extends AutomationSource> = ValueOf<
  (typeof AUTOMATION_SOURCE_EVENT_TYPES)[S]
>;

export type AutomationKnownEventType = {
  [S in AutomationSource]: AutomationEventTypeForSource<S>;
}[AutomationSource];

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
