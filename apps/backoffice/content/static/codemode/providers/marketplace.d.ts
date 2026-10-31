// Marketplace packages: search, inspect, publish, feature. Read to find or publish a package.
type MarketplaceCodemodeProvider = {
  /**
   * Search published package metadata in the public Marketplace, or in the current organization's Marketplace with organization visibility. Follow nextCursor while hasNextPage is true, even when a candidate page has no matches.
   * Requires `marketplace.read`.
   */
  search(input: MarketplaceSearchInput): Promise<MarketplaceSearchOutput>;
  /**
   * Inspect published package metadata and cursor-paginated releases in the public Marketplace, or in the current organization's Marketplace with organization visibility. `release` is what installing one release (the latest unless version is given) sets up: the permissions to approve with packages.install, and the routes, event definitions, and agents it defines. Its routes' start_workflow paths are relative to the installation folder.
   * Requires `marketplace.read`.
   */
  view(input: MarketplaceViewInput): Promise<MarketplaceViewOutput>;
  /**
   * Publish a captured package from a root manifest.json containing name @<organization-slug>/<package-slug>. Public visibility publishes to the public Marketplace; organization visibility publishes to the owning organization's members-only Marketplace. Versions are immutable by default; System may explicitly replace them. Dry runs write nothing. Author and version overrides require System context.
   * Requires `marketplace.publish`.
   */
  publish(input: MarketplacePublishInput): Promise<MarketplacePublishOutput>;
  /**
   * List every feature entry with its state: active, scheduled, expired, or hidden (the listing is no longer published). In System scope this curates the public Marketplace and requires a System administrator; in organization scope it curates that organization's Marketplace and requires an organization owner or admin.
   * Requires `marketplace.read`.
   */
  featured(input: MarketplaceFeaturedInput): Promise<MarketplaceFeaturedOutput>;
};
declare const marketplace: MarketplaceCodemodeProvider;

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
type AutomationWorkflowEventInstanceIdTarget = {
  kind: "instance_id";
  template: string;
};
type AutomationWorkflowEventStoredInstanceIdTarget = {
  kind: "stored_instance_id";
  keyTemplate: string;
};
type MarketplaceSearchInput = {
  category?: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
  pageSize?: number;
  cursor?: string;
  query: string;
  visibility?: "public" | "organization";
};
type MarketplaceSearchOutput = {
  listings: {
    listingId: string;
    name: string;
    summary: string;
    publisherName: string;
    category: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
    tags: string[];
    latestVersion: string;
    featured: boolean;
  }[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type MarketplaceViewInput = {
  listingId: string;
  versionPageSize?: number;
  versionCursor?: string;
  visibility?: "public" | "organization";
  version?: string;
};
type MarketplaceViewOutput = {
  listing: {
    name: string;
    summary: string;
    description: string;
    tags: string[];
    category: "communication" | "developer-tools" | "operations" | "productivity" | "reporting";
    listingId: string;
    slug: string;
    publisherName: string;
    status: "published";
    latestVersion: string;
    publishedAt: string;
    updatedAt: string;
    featured: boolean;
  };
  versions: {
    version: string;
    publishedAt: string;
  }[];
  nextVersionCursor?: string;
  hasNextVersionPage: boolean;
  release: {
    permissions: BackofficePermissionRequirement[];
    routes: {
      id: string;
      name: string;
      enabled: boolean;
      priority: number;
      description?: string | null;
      trigger: AutomationRouteTrigger;
      action: AutomationRouteAction;
    }[];
    eventDefinitions: {
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
    }[];
    agents: {
      description: string;
      model: string | null;
      permissions: string[];
      instructions: string;
      agentName: string;
    }[];
    version: string;
  };
};
type MarketplacePublishInput = {
  packageRoot: string;
  visibility: "public" | "organization";
  dryRun?: boolean;
  skipAuthorCheck?: boolean;
  skipVersionCheck?: boolean;
};
type MarketplacePublishOutput =
  | {
      name: string;
      listingId: string;
      version: string;
      snapshotId: string;
      owner: {
        scope: {
          kind: "org";
          orgId: string;
        };
        publisherName: string;
      };
      marketplace:
        | {
            kind: "system";
          }
        | {
            kind: "org";
            orgId: string;
            jurisdiction: "eu" | "us" | null;
          };
      files: {
        relativePath: string;
        sizeBytes: number;
        checksum: string;
      }[];
      sizeBytes: number;
      state: "preview";
    }
  | {
      name: string;
      listingId: string;
      version: string;
      snapshotId: string;
      owner: {
        scope: {
          kind: "org";
          orgId: string;
        };
        publisherName: string;
      };
      marketplace:
        | {
            kind: "system";
          }
        | {
            kind: "org";
            orgId: string;
            jurisdiction: "eu" | "us" | null;
          };
      files: {
        relativePath: string;
        sizeBytes: number;
        checksum: string;
      }[];
      sizeBytes: number;
      state: "requested" | "published";
      workflowInstanceId: string;
      workflowScope: {
        kind: "system";
      };
    };
type MarketplaceFeaturedInput = Record<string, unknown>;
type MarketplaceFeaturedOutput = {
  entries: {
    listingId: string;
    name: string;
    state: "active" | "scheduled" | "expired" | "hidden";
    priority: number;
    note: string | null;
    startsAt: string;
    until: string | null;
    featuredBy: string;
    createdAt: string;
    updatedAt: string;
  }[];
  limit: number;
};
