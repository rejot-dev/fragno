// Automation routes: event or schedule triggers that start or signal workflows, forward events, or notify agents. Read to automate anything later or recurring.
type RouterCodemodeProvider = {
  /**
   * List database-backed automation routing rules.
   * Requires `router.read`.
   */
  list(): Promise<RouterListOutput>;
  /**
   * Get one database-backed automation routing rule.
   * Requires `router.read`.
   */
  get(input: RouterGetInput): Promise<RouterGetOutput>;
  /**
   * Create a database-backed automation routing rule. An installed app may only create notify_app routes to itself, which it then manages.
   * Requires `router.modify`.
   */
  create(input: RouterCreateInput): Promise<RouterCreateOutput>;
  /**
   * Update a database-backed automation routing rule. A route a package or an installed app manages (steward kind 'package' or 'app') only accepts enabling or disabling it; change its definition through its steward.
   * Requires `router.modify`.
   */
  update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
  /**
   * Idempotently delete a database-backed automation route. Routes a package manages are removed by uninstalling the package; members may delete an installed app's routes.
   * Requires `router.modify`.
   */
  delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
  /**
   * Trigger a scheduled automation route immediately without changing its cadence.
   * Requires `router.modify`.
   */
  triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
  /**
   * List the forward accepts of this scope: which scopes of other owners may forward events into it, and which of their events it takes in.
   * Requires `router.read`.
   */
  acceptsList(): Promise<RouterAcceptsListOutput>;
  /**
   * Let scopes of another owner forward events into this scope. 'from' names the senders: 'members', the personal scopes of the members of the organization that owns this scope, or one 'scope'. The matcher reads the forwarded event, such as $.source, $.eventType, or $.payload fields; null lets every event in. Forwards from System, and from scopes of this scope's own owner, need no accept.
   * Requires `router.modify`.
   */
  acceptsCreate(input: RouterAcceptsCreateInput): Promise<RouterAcceptsCreateOutput>;
  /**
   * Update a forward accept of this scope. Disabling it, or narrowing it, makes the forwards it no longer lets in fail at the scope that sends them.
   * Requires `router.modify`.
   */
  acceptsUpdate(input: RouterAcceptsUpdateInput): Promise<RouterAcceptsUpdateOutput>;
  /**
   * Idempotently delete a forward accept of this scope.
   * Requires `router.modify`.
   */
  acceptsDelete(input: RouterAcceptsDeleteInput): Promise<RouterAcceptsDeleteOutput>;
};
declare const router: RouterCodemodeProvider;

type AutomationRoute = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  trigger: AutomationRouteTrigger;
  action: AutomationRouteAction;
  description?: string | null;
  steward: AutomationRouteSteward;
  metadata: {
    createdByActors: AutomationActors;
    updatedByActors: AutomationActors;
  } | null;
  nextOccurrenceAt: string | null;
};
type AutomationRouteTrigger =
  | {
      kind: "event";
      source: string;
      eventType: string;
      matcher: AutomationEventMatcher | null;
    }
  | {
      kind: "schedule";
      cadence:
        | {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          }
        | {
            kind: "cron";
            expression: string;
            timeZone: string;
          };
    };
type AutomationRouteAction =
  | AutomationStartWorkflowAction
  | AutomationSendWorkflowEventAction
  | AutomationForwardEventAction
  | AutomationReclassifyEventAction
  | AutomationNotifyAgentAction
  | AutomationNotifyAppAction;
type AutomationRouteSteward =
  | {
      kind: "members";
    }
  | {
      kind: "package";
      listingId: string;
    }
  | {
      kind: "app";
      appId: string;
    };
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
type AutomationEventMatcher =
  | {
      actor:
        | {
            participation: "initiator" | "principal";
            scope: "internal";
            type?: string;
            id?: string;
          }
        | {
            participation: "initiator" | "principal";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          }
        | {
            participation: "delegation";
            scope: "internal";
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          }
        | {
            participation: "delegation";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
            role?: "delegate" | "assistant";
          };
    }
  | {
      path: string;
      op: "exists";
    }
  | {
      path: string;
      op: "eq" | "neq" | "startsWith" | "includes";
      value: unknown;
    }
  | {
      all: AutomationEventMatcher[];
    }
  | {
      any: AutomationEventMatcher[];
    }
  | {
      not: AutomationEventMatcher;
    };
type AutomationStartWorkflowAction = {
  kind: "start_workflow";
  authority: AutomationAuthorityMode;
  workflowScriptPath: string;
  instanceIdTemplate: string;
};
type AutomationSendWorkflowEventAction = {
  kind: "send_workflow_event";
  target: AutomationWorkflowEventTarget;
  eventType: string;
  payload?: unknown;
};
type AutomationForwardEventAction = {
  kind: "forward_event";
  targetScope: AutomationRouteScopeTemplate;
  idTemplate?: string;
};
type AutomationReclassifyEventAction = {
  kind: "reclassify_event";
  source: string;
  eventType: string;
  payload: AutomationEventPayloadProjection;
};
type AutomationNotifyAgentAction = {
  kind: "notify_agent";
  agentName: string;
  authority: AutomationAuthorityMode;
};
type AutomationNotifyAppAction = {
  kind: "notify_app";
  appId: string;
};
type AutomationAuthorityMode =
  | {
      kind: "delegated-user" | "linked-user";
      grants: BackofficePermissionRequirement[] | "inherit";
    }
  | {
      kind: "organization-automation";
      grants: BackofficePermissionRequirement[];
    };
type AutomationWorkflowEventTarget =
  | AutomationWorkflowEventInstanceIdTarget
  | AutomationWorkflowEventStoredInstanceIdTarget;
type AutomationRouteScopeTemplate =
  | {
      kind: "system" | "subject";
    }
  | {
      kind: "org";
      orgIdTemplate: string;
    }
  | {
      kind: "user";
      userIdTemplate: string;
    }
  | {
      kind: "app";
      owner:
        | {
            kind: "org";
            orgIdTemplate: string;
          }
        | {
            kind: "user";
            userIdTemplate: string;
          };
      appIdTemplate: string;
    }
  | {
      kind: "project";
      owner:
        | {
            kind: "org";
            orgIdTemplate: string;
          }
        | {
            kind: "user";
            userIdTemplate: string;
          }
        | {
            kind: "app";
            owner:
              | {
                  kind: "org";
                  orgIdTemplate: string;
                }
              | {
                  kind: "user";
                  userIdTemplate: string;
                };
            appIdTemplate: string;
          };
      projectIdTemplate: string;
    };
type AutomationEventPayloadProjection = {
  kind: "projection";
  fields: {
    [key: string]: string;
  };
};
type BackofficePermissionRequirement =
  | {
      namespace: "account";
      permission: "read" | "manage";
    }
  | {
      namespace: "admin";
      permission:
        | "apps.manage"
        | "apps.read"
        | "oauth-clients.manage"
        | "oauth-clients.read"
        | "access-codes.manage"
        | "organizations.manage"
        | "users.manage";
    }
  | {
      namespace: "apps";
      permission: "read" | "manage";
    }
  | {
      namespace: "cloudflare";
      permission: "browserRun";
    }
  | {
      namespace: "connections";
      permission: "manage" | "read";
    }
  | {
      namespace: "events";
      permission: "emit" | "manage" | "read" | "route";
    }
  | {
      namespace: "hooks";
      permission: "read";
    }
  | {
      namespace: "identity";
      permission: "link" | "bind" | "read" | "resolve" | "revoke";
    }
  | {
      namespace: "integrations";
      permission: "read" | "manage" | "execute";
    }
  | {
      namespace: "internal";
      permission: "manage";
    }
  | {
      namespace: "org";
      permission: "read" | "manage";
    }
  | {
      namespace: "models";
      permission: "classify" | "generateImage" | "extract" | "run";
    }
  | {
      namespace: "marketplace";
      permission: "read" | "publish" | "feature";
    }
  | {
      namespace: "packages";
      permission: "read" | "install";
    }
  | {
      namespace: "otp";
      permission: "create";
    }
  | {
      namespace: "pi";
      permission: "manage" | "modify" | "read";
    }
  | {
      namespace: "projects";
      permission: "create" | "read";
    }
  | {
      namespace: "reson8";
      permission: "transcribe";
    }
  | {
      namespace: "router";
      permission: "modify" | "read";
    }
  | {
      namespace: "sandbox";
      permission: "modify" | "read";
    }
  | {
      namespace: "store";
      permission: "modify" | "read";
    }
  | {
      namespace: "upload";
      permission: "modify" | "read";
    }
  | {
      namespace: "web";
      permission: "download";
    }
  | {
      namespace: "workflow";
      permission: "executeCode" | "modify" | "read";
    };
type AutomationWorkflowEventInstanceIdTarget = {
  kind: "instance_id";
  template: string;
};
type AutomationWorkflowEventStoredInstanceIdTarget = {
  kind: "stored_instance_id";
  keyTemplate: string;
};
type AutomationRouteTriggerInput =
  | {
      kind: "event";
      source: string;
      eventType: string;
      matcher?: AutomationEventMatcher | null;
    }
  | {
      kind: "schedule";
      cadence:
        | {
            kind: "once";
            /** ISO 8601 datetime string. */
            at: string;
          }
        | {
            kind: "cron";
            expression: string;
            timeZone?: string;
          };
    };
type AutomationForwardAccept = {
  id: string;
  name: string;
  enabled: boolean;
  from: AutomationForwardSenders;
  matcher: AutomationEventMatcher | null;
  description: string | null;
};
type AutomationForwardSenders =
  | {
      kind: "members";
    }
  | {
      kind: "scope";
      scope:
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
    };
type AutomationForwardSendersInput =
  | {
      kind: "members";
    }
  | {
      kind: "scope";
      scope:
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
type RouterListOutput = AutomationRoute[];
type RouterGetInput = {
  id: string;
};
type RouterGetOutput = AutomationRoute | null;
type RouterCreateInput = {
  id: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  description?: string | null;
  trigger: AutomationRouteTriggerInput;
  action: AutomationRouteAction;
};
type RouterCreateOutput = AutomationRoute;
type RouterUpdateInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  trigger?: AutomationRouteTriggerInput;
  action?: AutomationRouteAction;
  description?: string | null;
};
type RouterUpdateOutput = AutomationRoute | null;
type RouterDeleteInput = {
  id: string;
};
type RouterDeleteOutput = {
  deleted: true;
};
type RouterTriggerNowInput = {
  id: string;
};
type RouterTriggerNowOutput = {
  accepted: true;
  eventId: string;
} | null;
type RouterAcceptsListOutput = AutomationForwardAccept[];
type RouterAcceptsCreateInput = {
  id: string;
  name: string;
  enabled?: boolean;
  from: AutomationForwardSendersInput;
  matcher?: AutomationEventMatcher | null;
  description?: string | null;
};
type RouterAcceptsCreateOutput = AutomationForwardAccept;
type RouterAcceptsUpdateInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  from?: AutomationForwardSendersInput;
  matcher?: AutomationEventMatcher | null;
  description?: string | null;
};
type RouterAcceptsUpdateOutput = AutomationForwardAccept | null;
type RouterAcceptsDeleteInput = {
  id: string;
};
type RouterAcceptsDeleteOutput = {
  deleted: true;
};
