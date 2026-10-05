// events tools
type EventsCodemodeProvider = {
  /** Fire an automation event for the current context or a selected target scope. */
  fire(input: EventsFireInput): Promise<EventsFireOutput>;
  /** List stored automation events in the current scope, newest first. */
  list(input: EventsListInput): Promise<EventsListOutput>;
  /** Get one stored automation event by id in the current scope. */
  get(input: EventsGetInput): Promise<EventsGetOutput>;
  /** List known automation event source/type pairs from the Backoffice capability registry. */
  catalogList(): Promise<EventsCatalogListOutput>;
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
type EventsListInput = {
  limit?: number;
  cursor?: string;
};
type EventsListOutput = {
  events: {
    id: string;
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
    /** ISO 8601 datetime string. */
    occurredAt: string;
    payload: {
      [key: string]: unknown;
    };
    actors: {
      initiator:
        | {
            scope: "internal";
            type: string;
            id: string;
            role: "initiator";
          }
        | {
            scope: "external";
            source: string;
            type: string;
            id: string;
            role: "initiator";
          };
      principal:
        | {
            scope: "internal";
            type: string;
            id: string;
            role: "principal";
          }
        | {
            scope: "external";
            source: string;
            type: string;
            id: string;
            role: "principal";
          }
        | null;
      delegation: (
        | {
            scope: "internal";
            type: string;
            id: string;
            role: "delegate";
          }
        | {
            scope: "external";
            source: string;
            type: string;
            id: string;
            role: "delegate";
          }
        | {
            scope: "internal";
            type: string;
            id: string;
            role: "assistant";
          }
        | {
            scope: "external";
            source: string;
            type: string;
            id: string;
            role: "assistant";
          }
      )[];
    };
    subject: {
      orgId?: string;
      userId?: string;
      [key: string]: unknown;
    } | null;
    /** ISO 8601 datetime string. */
    createdAt?: string;
  }[];
  nextCursor?: string;
  hasNextPage: boolean;
};
type EventsGetInput = {
  id: string;
};
type EventsGetOutput = {
  id: string;
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
  /** ISO 8601 datetime string. */
  occurredAt: string;
  payload: {
    [key: string]: unknown;
  };
  actors: {
    initiator:
      | {
          scope: "internal";
          type: string;
          id: string;
          role: "initiator";
        }
      | {
          scope: "external";
          source: string;
          type: string;
          id: string;
          role: "initiator";
        };
    principal:
      | {
          scope: "internal";
          type: string;
          id: string;
          role: "principal";
        }
      | {
          scope: "external";
          source: string;
          type: string;
          id: string;
          role: "principal";
        }
      | null;
    delegation: (
      | {
          scope: "internal";
          type: string;
          id: string;
          role: "delegate";
        }
      | {
          scope: "external";
          source: string;
          type: string;
          id: string;
          role: "delegate";
        }
      | {
          scope: "internal";
          type: string;
          id: string;
          role: "assistant";
        }
      | {
          scope: "external";
          source: string;
          type: string;
          id: string;
          role: "assistant";
        }
    )[];
  };
  subject: {
    orgId?: string;
    userId?: string;
    [key: string]: unknown;
  } | null;
  /** ISO 8601 datetime string. */
  createdAt?: string;
} | null;
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
