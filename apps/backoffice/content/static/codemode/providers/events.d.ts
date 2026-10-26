// Automation events: catalog, stored events and the routes they matched, firing, retries. Read to see what can trigger automations or why one did not act.
type EventsCodemodeProvider = {
  /**
   * Fire an automation event for the current context or a selected target scope. Sources starting with `app:` belong to installed apps, and only an app's own credential emits them.
   * Requires `events.emit`.
   */
  fire(input: EventsFireInput): Promise<EventsFireOutput>;
  /**
   * List stored automation events in the current scope, newest first, each with the routes it matched and where they stand.
   * Requires `events.read`.
   */
  list(input: EventsListInput): Promise<EventsListOutput>;
  /**
   * Get one stored automation event by id in the current scope, with each route it matched and where that route stands: about to act, retrying after an error, completed with what it did, or failed for good.
   * Requires `events.read`.
   */
  get(input: EventsGetInput): Promise<EventsGetOutput>;
  /**
   * List the routes in one state on stored events in the current scope, such as those that failed for good or are retrying, each with the event it matched, newest match first. Use events.get for the whole event.
   * Requires `events.read`.
   */
  routesList(input: EventsRoutesListInput): Promise<EventsRoutesListOutput>;
  /**
   * Retry a route that failed for good on a stored event, with a fresh set of attempts. The route acts as it was when the event matched it, with the route's current permissions, so retry after fixing what it depends on, such as a missing workflow run or permission; changes to the route's action apply only to new events. Returns the route, now pending, or null when the event did not match it.
   * Requires `router.modify`.
   */
  routesRetry(input: EventsRoutesRetryInput): Promise<EventsRoutesRetryOutput>;
  /**
   * List known automation event source/type pairs from the Backoffice capability registry.
   * Requires `events.read`.
   */
  catalogList(): Promise<EventsCatalogListOutput>;
  /**
   * Get one automation event descriptor and its JSON schemas.
   * Requires `events.read`.
   */
  catalogGet(input: EventsCatalogGetInput): Promise<EventsCatalogGetOutput>;
  /**
   * Create a scoped dynamic automation event definition with optional JSON schemas.
   * Requires `events.manage`.
   */
  catalogCreate(input: EventsCatalogCreateInput): Promise<EventsCatalogCreateOutput>;
};
declare const events: EventsCodemodeProvider;

type AutomationActors = {
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
        role: "delegate" | "assistant";
      }
    | {
        scope: "external";
        source: string;
        type: string;
        id: string;
        role: "delegate" | "assistant";
      }
  )[];
};
type AutomationSteward =
  | {
      kind: "members";
    }
  | {
      kind: "package";
      listingId: string;
    };
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
        jurisdiction?: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction?: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction?: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction?: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction?: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction?: "eu" | "us" | null;
                  };
              appId: string;
            };
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
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction: "eu" | "us" | null;
                  };
              appId: string;
            };
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
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "user";
          userId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                      jurisdiction: "eu" | "us" | null;
                    }
                  | {
                      kind: "user";
                      userId: string;
                      jurisdiction: "eu" | "us" | null;
                    };
                appId: string;
              };
          projectId: string;
        };
    scopeRestriction:
      | {
          kind: "system";
        }
      | {
          kind: "org";
          orgId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "user";
          userId: string;
          jurisdiction: "eu" | "us" | null;
        }
      | {
          kind: "app";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              };
          appId: string;
        }
      | {
          kind: "project";
          owner:
            | {
                kind: "org";
                orgId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "user";
                userId: string;
                jurisdiction: "eu" | "us" | null;
              }
            | {
                kind: "app";
                owner:
                  | {
                      kind: "org";
                      orgId: string;
                      jurisdiction: "eu" | "us" | null;
                    }
                  | {
                      kind: "user";
                      userId: string;
                      jurisdiction: "eu" | "us" | null;
                    };
                appId: string;
              };
          projectId: string;
        }
      | null;
    source: string;
    eventType: string;
    /** ISO 8601 datetime string. */
    occurredAt: string;
    payload: {
      [key: string]: unknown;
    };
    actors: AutomationActors;
    subject: {
      orgId?: string;
      userId?: string;
      [key: string]: unknown;
    } | null;
    causation:
      | {
          kind: "origin";
        }
      | {
          kind: "route";
          routeId: string;
          parent: {
            eventId: string;
            rootEventId: string;
          };
        }
      | {
          kind: "workflow";
          workflowName: string;
          instanceId: string;
          parent: {
            eventId: string;
            rootEventId: string;
          } | null;
        };
    /** ISO 8601 datetime string. */
    createdAt?: string;
    routing:
      | {
          status: "matching";
        }
      | {
          status: "matched";
          routes: (
            | {
                routeId: string;
                routeName: string;
                /** ISO 8601 datetime string. */
                matchedAt: string;
                status: "pending";
              }
            | {
                routeId: string;
                routeName: string;
                /** ISO 8601 datetime string. */
                matchedAt: string;
                status: "retrying" | "failed";
                failedAttempts: number;
                error: string;
              }
            | {
                routeId: string;
                routeName: string;
                /** ISO 8601 datetime string. */
                matchedAt: string;
                status: "completed";
                outcome:
                  | {
                      kind: "workflow_started";
                      workflowName: string;
                      instanceId: string;
                    }
                  | {
                      kind: "workflow_event_sent";
                      workflowName: string;
                      instanceId: string;
                      eventType: string;
                    }
                  | {
                      kind: "event_forwarded";
                      eventId: string;
                      scope:
                        | {
                            kind: "system";
                          }
                        | {
                            kind: "org";
                            orgId: string;
                            jurisdiction: "eu" | "us" | null;
                          }
                        | {
                            kind: "user";
                            userId: string;
                            jurisdiction: "eu" | "us" | null;
                          }
                        | {
                            kind: "app";
                            owner:
                              | {
                                  kind: "org";
                                  orgId: string;
                                  jurisdiction: "eu" | "us" | null;
                                }
                              | {
                                  kind: "user";
                                  userId: string;
                                  jurisdiction: "eu" | "us" | null;
                                };
                            appId: string;
                          }
                        | {
                            kind: "project";
                            owner:
                              | {
                                  kind: "org";
                                  orgId: string;
                                  jurisdiction: "eu" | "us" | null;
                                }
                              | {
                                  kind: "user";
                                  userId: string;
                                  jurisdiction: "eu" | "us" | null;
                                }
                              | {
                                  kind: "app";
                                  owner:
                                    | {
                                        kind: "org";
                                        orgId: string;
                                        jurisdiction: "eu" | "us" | null;
                                      }
                                    | {
                                        kind: "user";
                                        userId: string;
                                        jurisdiction: "eu" | "us" | null;
                                      };
                                  appId: string;
                                };
                            projectId: string;
                          };
                    }
                  | {
                      kind: "event_reclassified";
                      eventId: string;
                    }
                  | {
                      kind: "agent_notified";
                      agentName: string;
                    }
                  | {
                      kind: "skipped";
                      reason:
                        | "no_linked_external_sender"
                        | "workflow_instance_unresolved"
                        | "caused_by_notified_agent";
                    };
                failedAttempts: number;
              }
          )[];
        };
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
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction: "eu" | "us" | null;
                  };
              appId: string;
            };
        projectId: string;
      };
  scopeRestriction:
    | {
        kind: "system";
      }
    | {
        kind: "org";
        orgId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "user";
        userId: string;
        jurisdiction: "eu" | "us" | null;
      }
    | {
        kind: "app";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            };
        appId: string;
      }
    | {
        kind: "project";
        owner:
          | {
              kind: "org";
              orgId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "user";
              userId: string;
              jurisdiction: "eu" | "us" | null;
            }
          | {
              kind: "app";
              owner:
                | {
                    kind: "org";
                    orgId: string;
                    jurisdiction: "eu" | "us" | null;
                  }
                | {
                    kind: "user";
                    userId: string;
                    jurisdiction: "eu" | "us" | null;
                  };
              appId: string;
            };
        projectId: string;
      }
    | null;
  source: string;
  eventType: string;
  /** ISO 8601 datetime string. */
  occurredAt: string;
  payload: {
    [key: string]: unknown;
  };
  actors: AutomationActors;
  subject: {
    orgId?: string;
    userId?: string;
    [key: string]: unknown;
  } | null;
  causation:
    | {
        kind: "origin";
      }
    | {
        kind: "route";
        routeId: string;
        parent: {
          eventId: string;
          rootEventId: string;
        };
      }
    | {
        kind: "workflow";
        workflowName: string;
        instanceId: string;
        parent: {
          eventId: string;
          rootEventId: string;
        } | null;
      };
  /** ISO 8601 datetime string. */
  createdAt?: string;
  routing:
    | {
        status: "matching";
      }
    | {
        status: "matched";
        routes: (
          | {
              routeId: string;
              routeName: string;
              /** ISO 8601 datetime string. */
              matchedAt: string;
              status: "pending";
            }
          | {
              routeId: string;
              routeName: string;
              /** ISO 8601 datetime string. */
              matchedAt: string;
              status: "retrying" | "failed";
              failedAttempts: number;
              error: string;
            }
          | {
              routeId: string;
              routeName: string;
              /** ISO 8601 datetime string. */
              matchedAt: string;
              status: "completed";
              outcome:
                | {
                    kind: "workflow_started";
                    workflowName: string;
                    instanceId: string;
                  }
                | {
                    kind: "workflow_event_sent";
                    workflowName: string;
                    instanceId: string;
                    eventType: string;
                  }
                | {
                    kind: "event_forwarded";
                    eventId: string;
                    scope:
                      | {
                          kind: "system";
                        }
                      | {
                          kind: "org";
                          orgId: string;
                          jurisdiction: "eu" | "us" | null;
                        }
                      | {
                          kind: "user";
                          userId: string;
                          jurisdiction: "eu" | "us" | null;
                        }
                      | {
                          kind: "app";
                          owner:
                            | {
                                kind: "org";
                                orgId: string;
                                jurisdiction: "eu" | "us" | null;
                              }
                            | {
                                kind: "user";
                                userId: string;
                                jurisdiction: "eu" | "us" | null;
                              };
                          appId: string;
                        }
                      | {
                          kind: "project";
                          owner:
                            | {
                                kind: "org";
                                orgId: string;
                                jurisdiction: "eu" | "us" | null;
                              }
                            | {
                                kind: "user";
                                userId: string;
                                jurisdiction: "eu" | "us" | null;
                              }
                            | {
                                kind: "app";
                                owner:
                                  | {
                                      kind: "org";
                                      orgId: string;
                                      jurisdiction: "eu" | "us" | null;
                                    }
                                  | {
                                      kind: "user";
                                      userId: string;
                                      jurisdiction: "eu" | "us" | null;
                                    };
                                appId: string;
                              };
                          projectId: string;
                        };
                  }
                | {
                    kind: "event_reclassified";
                    eventId: string;
                  }
                | {
                    kind: "agent_notified";
                    agentName: string;
                  }
                | {
                    kind: "skipped";
                    reason:
                      | "no_linked_external_sender"
                      | "workflow_instance_unresolved"
                      | "caused_by_notified_agent";
                  };
              failedAttempts: number;
            }
        )[];
      };
} | null;
type EventsRoutesListInput = {
  status: "pending" | "retrying" | "completed" | "failed";
  limit?: number;
  cursor?: string;
};
type EventsRoutesListOutput = {
  routes: {
    eventId: string;
    route:
      | {
          routeId: string;
          routeName: string;
          /** ISO 8601 datetime string. */
          matchedAt: string;
          status: "pending";
        }
      | {
          routeId: string;
          routeName: string;
          /** ISO 8601 datetime string. */
          matchedAt: string;
          status: "retrying" | "failed";
          failedAttempts: number;
          error: string;
        }
      | {
          routeId: string;
          routeName: string;
          /** ISO 8601 datetime string. */
          matchedAt: string;
          status: "completed";
          outcome:
            | {
                kind: "workflow_started";
                workflowName: string;
                instanceId: string;
              }
            | {
                kind: "workflow_event_sent";
                workflowName: string;
                instanceId: string;
                eventType: string;
              }
            | {
                kind: "event_forwarded";
                eventId: string;
                scope:
                  | {
                      kind: "system";
                    }
                  | {
                      kind: "org";
                      orgId: string;
                      jurisdiction: "eu" | "us" | null;
                    }
                  | {
                      kind: "user";
                      userId: string;
                      jurisdiction: "eu" | "us" | null;
                    }
                  | {
                      kind: "app";
                      owner:
                        | {
                            kind: "org";
                            orgId: string;
                            jurisdiction: "eu" | "us" | null;
                          }
                        | {
                            kind: "user";
                            userId: string;
                            jurisdiction: "eu" | "us" | null;
                          };
                      appId: string;
                    }
                  | {
                      kind: "project";
                      owner:
                        | {
                            kind: "org";
                            orgId: string;
                            jurisdiction: "eu" | "us" | null;
                          }
                        | {
                            kind: "user";
                            userId: string;
                            jurisdiction: "eu" | "us" | null;
                          }
                        | {
                            kind: "app";
                            owner:
                              | {
                                  kind: "org";
                                  orgId: string;
                                  jurisdiction: "eu" | "us" | null;
                                }
                              | {
                                  kind: "user";
                                  userId: string;
                                  jurisdiction: "eu" | "us" | null;
                                };
                            appId: string;
                          };
                      projectId: string;
                    };
              }
            | {
                kind: "event_reclassified";
                eventId: string;
              }
            | {
                kind: "agent_notified";
                agentName: string;
              }
            | {
                kind: "skipped";
                reason:
                  | "no_linked_external_sender"
                  | "workflow_instance_unresolved"
                  | "caused_by_notified_agent";
              };
          failedAttempts: number;
        };
  }[];
  nextCursor?: string;
  hasNextPage: boolean;
};
type EventsRoutesRetryInput = {
  eventId: string;
  routeId: string;
};
type EventsRoutesRetryOutput =
  | {
      routeId: string;
      routeName: string;
      /** ISO 8601 datetime string. */
      matchedAt: string;
      status: "pending";
    }
  | {
      routeId: string;
      routeName: string;
      /** ISO 8601 datetime string. */
      matchedAt: string;
      status: "retrying" | "failed";
      failedAttempts: number;
      error: string;
    }
  | {
      routeId: string;
      routeName: string;
      /** ISO 8601 datetime string. */
      matchedAt: string;
      status: "completed";
      outcome:
        | {
            kind: "workflow_started";
            workflowName: string;
            instanceId: string;
          }
        | {
            kind: "workflow_event_sent";
            workflowName: string;
            instanceId: string;
            eventType: string;
          }
        | {
            kind: "event_forwarded";
            eventId: string;
            scope:
              | {
                  kind: "system";
                }
              | {
                  kind: "org";
                  orgId: string;
                  jurisdiction: "eu" | "us" | null;
                }
              | {
                  kind: "user";
                  userId: string;
                  jurisdiction: "eu" | "us" | null;
                }
              | {
                  kind: "app";
                  owner:
                    | {
                        kind: "org";
                        orgId: string;
                        jurisdiction: "eu" | "us" | null;
                      }
                    | {
                        kind: "user";
                        userId: string;
                        jurisdiction: "eu" | "us" | null;
                      };
                  appId: string;
                }
              | {
                  kind: "project";
                  owner:
                    | {
                        kind: "org";
                        orgId: string;
                        jurisdiction: "eu" | "us" | null;
                      }
                    | {
                        kind: "user";
                        userId: string;
                        jurisdiction: "eu" | "us" | null;
                      }
                    | {
                        kind: "app";
                        owner:
                          | {
                              kind: "org";
                              orgId: string;
                              jurisdiction: "eu" | "us" | null;
                            }
                          | {
                              kind: "user";
                              userId: string;
                              jurisdiction: "eu" | "us" | null;
                            };
                        appId: string;
                      };
                  projectId: string;
                };
          }
        | {
            kind: "event_reclassified";
            eventId: string;
          }
        | {
            kind: "agent_notified";
            agentName: string;
          }
        | {
            kind: "skipped";
            reason:
              | "no_linked_external_sender"
              | "workflow_instance_unresolved"
              | "caused_by_notified_agent";
          };
      failedAttempts: number;
    }
  | null;
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
  steward: AutomationSteward;
  /** ISO 8601 datetime string. */
  createdAt?: string;
  /** ISO 8601 datetime string. */
  updatedAt?: string;
};
