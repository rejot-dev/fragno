// events tools
type EventsCodemodeProvider = {
  /** Fire an automation event for the current context or a selected target scope. */
  fire(input: EventsFireInput): Promise<EventsFireOutput>;
  /** List known automation event source/type pairs from the Backoffice capability registry. */
  catalogList(input: EventsCatalogListInput): Promise<EventsCatalogListOutput>;
  /** Get one automation event descriptor and its JSON schemas. */
  catalogGet(input: EventsCatalogGetInput): Promise<EventsCatalogGetOutput>;
  /** Create a scoped dynamic automation event definition with optional JSON schemas. */
  catalogCreate(input: EventsCatalogCreateInput): Promise<EventsCatalogCreateOutput>;
};
declare const events: EventsCodemodeProvider;

type EventsFireInput = {
  eventType: string;
  source?: string;
  subjectUserId?: string;
  payload?: {
    [key: string]: unknown;
  };
  targetScope?:
    | {
        kind: "system";
      }
    | {
        kind: "org";
        orgId: string;
      }
    | {
        kind: "user";
        userId: string;
      }
    | {
        kind: "project";
        orgId: string;
        projectId: string;
      };
};
type EventsFireOutput = {
  accepted: boolean;
  eventId: string;
  scope:
    | {
        kind: "system";
      }
    | {
        kind: "org";
        orgId: string;
      }
    | {
        kind: "user";
        userId: string;
      }
    | {
        kind: "project";
        orgId: string;
        projectId: string;
      };
  source: string;
  eventType: string;
};
type EventsCatalogListInput = Record<string, unknown>;
type EventsCatalogListOutput = {
  source: string;
  eventType: string;
  label: string;
  description?: string;
  capabilityId: string;
  example?: unknown;
}[];
type EventsCatalogGetInput = {
  source: string;
  eventType: string;
};
type EventsCatalogGetOutput = {
  source: string;
  eventType: string;
  label: string;
  description?: string;
  capabilityId: string;
  payloadSchema?: {
    [key: string]: unknown;
  };
  actorSchema?: {
    [key: string]: unknown;
  };
  subjectSchema?: {
    [key: string]: unknown;
  };
  example?: unknown;
} | null;
type EventsCatalogCreateInput = {
  source: string;
  eventType: string;
  label: string;
  description?: string | null;
  payloadSchema?: {
    [key: string]: unknown;
  } | null;
  actorSchema?: {
    [key: string]: unknown;
  } | null;
  subjectSchema?: {
    [key: string]: unknown;
  } | null;
  example?: unknown | null;
  enabled?: boolean;
};
type EventsCatalogCreateOutput = {
  id: string;
  source: string;
  eventType: string;
  label: string;
  description?: string | null;
  payloadSchema?: {
    [key: string]: unknown;
  } | null;
  actorSchema?: {
    [key: string]: unknown;
  } | null;
  subjectSchema?: {
    [key: string]: unknown;
  } | null;
  example?: unknown | null;
  enabled: boolean;
  capabilityId: string;
  /** ISO 8601 datetime string. */
  createdAt?: string;
  /** ISO 8601 datetime string. */
  updatedAt?: string;
};
