import type { ZodType } from "zod";

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

export type AutomationSourceEventCatalog<S extends AutomationSource> = Record<
  Extract<AutomationEventTypeForSource<S>, string>,
  ZodType
>;

export type AutomationBashEnvironment = Record<string, string | undefined>;

export type AutomationSourceReplyInput = {
  event: AutomationEvent;
  externalActorId: string;
  text: string;
};

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

export interface AutomationSourceAdapter<S extends AutomationSource> {
  source: S;
  eventSchemas: AutomationSourceEventCatalog<S>;
  toBashEnv: (event: AutomationEvent) => AutomationBashEnvironment;
  reply?: (input: AutomationSourceReplyInput) => Promise<void>;
}

export type AutomationSourceAdapterRegistry = {
  [S in AutomationSource]: AutomationSourceAdapter<S>;
};

export type AnyAutomationSourceAdapter = AutomationSourceAdapterRegistry[AutomationSource];

export const getSourceAdapter = (
  sourceAdapters: Partial<AutomationSourceAdapterRegistry> | undefined,
  source: string,
): AnyAutomationSourceAdapter | undefined => {
  if (!sourceAdapters) {
    return undefined;
  }

  return source in sourceAdapters
    ? sourceAdapters[source as keyof AutomationSourceAdapterRegistry]
    : undefined;
};
