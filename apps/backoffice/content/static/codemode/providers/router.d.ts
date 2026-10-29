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
   * Create a database-backed automation routing rule.
   * Requires `router.modify`.
   */
  create(input: RouterCreateInput): Promise<RouterCreateOutput>;
  /**
   * Update a database-backed automation routing rule. A route a package manages (steward kind 'package') only accepts enabling or disabling it; change its definition through the package.
   * Requires `router.modify`.
   */
  update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
  /**
   * Idempotently delete a database-backed automation route. Routes a package manages are removed by uninstalling the package.
   * Requires `router.modify`.
   */
  delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
  /**
   * Trigger a scheduled automation route immediately without changing its cadence.
   * Requires `router.modify`.
   */
  triggerNow(input: RouterTriggerNowInput): Promise<RouterTriggerNowOutput>;
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
  steward: AutomationSteward;
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
  | AutomationNotifyAgentAction;
type AutomationSteward =
  | {
      kind: "members";
    }
  | {
      kind: "package";
      listingId: string;
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
        | "sign-up-invitations.manage"
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
      namespace: "forms";
      permission: "create" | "read" | "update";
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
