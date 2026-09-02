// router tools
type RouterCodemodeProvider = {
  /** List database-backed automation routing rules. */
  list(input: RouterListInput): Promise<RouterListOutput>;
  /** Get one database-backed automation routing rule. */
  get(input: RouterGetInput): Promise<RouterGetOutput>;
  /** Create a database-backed automation routing rule. */
  create(input: RouterCreateInput): Promise<RouterCreateOutput>;
  /** Update a database-backed automation routing rule. */
  update(input: RouterUpdateInput): Promise<RouterUpdateOutput>;
  /** Idempotently delete a database-backed automation route. */
  delete(input: RouterDeleteInput): Promise<RouterDeleteOutput>;
  /** Trigger a scheduled automation route immediately without changing its cadence. */
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
  metadata: {
    createdByActors: {
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
    updatedByActors: {
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
    managedBy: AutomationRouteManagedBy | null;
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
  | AutomationReclassifyEventAction;
type AutomationRouteManagedBy = {
  kind: "marketplace";
  listingId: string;
  resourceKey: string;
  version: string;
};
type AutomationEventMatcher =
  | {
      actor:
        | {
            participation: "initiator";
            scope: "internal";
            type?: string;
            id?: string;
          }
        | {
            participation: "initiator";
            scope: "external";
            source?: string;
            type?: string;
            id?: string;
          }
        | {
            participation: "principal";
            scope: "internal";
            type?: string;
            id?: string;
          }
        | {
            participation: "principal";
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
  authority:
    | {
        kind: "delegated-user";
        grants: BackofficePermissionRequirement[] | "inherit";
      }
    | {
        kind: "linked-user";
        grants: BackofficePermissionRequirement[] | "inherit";
      }
    | {
        kind: "organization-automation";
        grants: BackofficePermissionRequirement[];
      };
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
type BackofficePermissionRequirement =
  | {
      namespace: "admin";
      permission: "sign-up-invitations.manage";
    }
  | {
      namespace: "admin";
      permission: "organizations.manage";
    }
  | {
      namespace: "api";
      permission: "connections.create";
    }
  | {
      namespace: "api";
      permission: "connections.delete";
    }
  | {
      namespace: "api";
      permission: "connections.read";
    }
  | {
      namespace: "api";
      permission: "requests.execute";
    }
  | {
      namespace: "api";
      permission: "webhooks.manage";
    }
  | {
      namespace: "api";
      permission: "webhooks.read";
    }
  | {
      namespace: "capabilities";
      permission: "read";
    }
  | {
      namespace: "cloudflare";
      permission: "browserRun";
    }
  | {
      namespace: "connections";
      permission: "manage";
    }
  | {
      namespace: "connections";
      permission: "read";
    }
  | {
      namespace: "events";
      permission: "emit";
    }
  | {
      namespace: "events";
      permission: "manage";
    }
  | {
      namespace: "events";
      permission: "read";
    }
  | {
      namespace: "events";
      permission: "route";
    }
  | {
      namespace: "forms";
      permission: "create";
    }
  | {
      namespace: "forms";
      permission: "read";
    }
  | {
      namespace: "forms";
      permission: "update";
    }
  | {
      namespace: "github";
      permission: "read";
    }
  | {
      namespace: "hooks";
      permission: "read";
    }
  | {
      namespace: "identity";
      permission: "bind";
    }
  | {
      namespace: "identity";
      permission: "read";
    }
  | {
      namespace: "identity";
      permission: "resolve";
    }
  | {
      namespace: "identity";
      permission: "revoke";
    }
  | {
      namespace: "internal";
      permission: "manage";
    }
  | {
      namespace: "internal";
      permission: "read";
    }
  | {
      namespace: "mcp";
      permission: "servers.create";
    }
  | {
      namespace: "mcp";
      permission: "servers.delete";
    }
  | {
      namespace: "mcp";
      permission: "servers.read";
    }
  | {
      namespace: "mcp";
      permission: "tools.call";
    }
  | {
      namespace: "otp";
      permission: "create";
    }
  | {
      namespace: "pi";
      permission: "modify";
    }
  | {
      namespace: "pi";
      permission: "read";
    }
  | {
      namespace: "resend";
      permission: "read";
    }
  | {
      namespace: "resend";
      permission: "send";
    }
  | {
      namespace: "reson8";
      permission: "use";
    }
  | {
      namespace: "router";
      permission: "modify";
    }
  | {
      namespace: "router";
      permission: "read";
    }
  | {
      namespace: "sandbox";
      permission: "modify";
    }
  | {
      namespace: "sandbox";
      permission: "read";
    }
  | {
      namespace: "store";
      permission: "modify";
    }
  | {
      namespace: "store";
      permission: "read";
    }
  | {
      namespace: "telegram";
      permission: "read";
    }
  | {
      namespace: "telegram";
      permission: "send";
    }
  | {
      namespace: "upload";
      permission: "modify";
    }
  | {
      namespace: "upload";
      permission: "read";
    }
  | {
      namespace: "workflow";
      permission: "executeCode";
    }
  | {
      namespace: "workflow";
      permission: "modify";
    }
  | {
      namespace: "workflow";
      permission: "read";
    };
type AutomationWorkflowEventTarget =
  | AutomationWorkflowEventInstanceIdTarget
  | AutomationWorkflowEventStoredInstanceIdTarget;
type AutomationRouteScopeTemplate =
  | {
      kind: "system";
    }
  | {
      kind: "org";
      orgIdTemplate: string;
    }
  | {
      kind: "project";
      orgIdTemplate: string;
      projectIdTemplate: string;
    }
  | {
      kind: "user";
      userIdTemplate: string;
    };
type AutomationEventPayloadProjection = {
  kind: "projection";
  fields: {
    [key: string]: string;
  };
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
type AutomationRouteActionInput =
  | AutomationStartWorkflowActionInput
  | AutomationSendWorkflowEventActionInput
  | AutomationForwardEventActionInput
  | AutomationReclassifyEventActionInput;
type AutomationStartWorkflowActionInput = {
  kind: "start_workflow";
  authority:
    | {
        kind: "delegated-user";
        grants: BackofficePermissionRequirement[] | "inherit";
      }
    | {
        kind: "linked-user";
        grants: BackofficePermissionRequirement[] | "inherit";
      }
    | {
        kind: "organization-automation";
        grants: BackofficePermissionRequirement[];
      };
  workflowScriptPath: string;
  instanceIdTemplate: string;
};
type AutomationSendWorkflowEventActionInput = {
  kind: "send_workflow_event";
  target: AutomationWorkflowEventTarget;
  eventType: string;
  payload?: unknown;
};
type AutomationForwardEventActionInput = {
  kind: "forward_event";
  targetScope: AutomationRouteScopeTemplate;
  idTemplate?: string;
};
type AutomationReclassifyEventActionInput = {
  kind: "reclassify_event";
  source: string;
  eventType: string;
  payload: AutomationEventPayloadProjection;
};
type RouterListInput = Record<string, unknown>;
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
  trigger: AutomationRouteTriggerInput;
  action: AutomationRouteActionInput;
  description?: string | null;
  managedBy?: AutomationRouteManagedBy | null;
};
type RouterCreateOutput = AutomationRoute;
type RouterUpdateInput = {
  id: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  trigger?: AutomationRouteTriggerInput;
  action?: AutomationRouteActionInput;
  description?: string | null;
  managedBy?: AutomationRouteManagedBy | null;
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
