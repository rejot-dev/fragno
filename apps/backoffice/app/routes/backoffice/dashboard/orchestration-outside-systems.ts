import {
  resolveAutomationGrantedConnectionScope,
  type AutomationRouteDefinition,
} from "@fragno-dev/backoffice-api/v0/automation";
import type { BackofficePermissionNamespace } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";
import type {
  OrchestrationExternal,
  OrchestrationExternalCall,
  OrchestrationInheritingWorkflow,
  OrchestrationUniverse,
} from "@fragno-private/design-system/orchestration/orchestration-universe-model";

import { scopeIdentity } from "@/fragno/automation/forward-accepts";
import type { IntegrationConnectionRecord } from "@/fragno/runtime-tools/families/integrations/integration-connections";

import { serviceIcon, workflowTargetId } from "./orchestration-graph";

/** The connections a scope keeps, as its replica records them. */
export type ScopeConnections = readonly Pick<
  IntegrationConnectionRecord,
  "connectionId" | "service" | "displayName"
>[];

/** A scope the universe read, whose routes grant its workflows what they may call. */
type GrantingScope = {
  scope: BackofficeContextScope;
  routes: readonly AutomationRouteDefinition[];
  connections: ScopeConnections;
};

/** The systems outside Backoffice that permissions other than executing integrations reach. */
const PERMISSION_SYSTEMS: Partial<Record<BackofficePermissionNamespace, OrchestrationExternal>> = {
  web: { id: "web", label: "Web", icon: "globe" },
  models: { id: "models", label: "Models", icon: "cpu" },
  cloudflare: { id: "browser-run", label: "Browser Run", icon: "monitor" },
};

/**
 * What the workflows on the universe's planets may call outside Backoffice, as the enabled routes
 * starting them grant by name: the connections they may execute on, the web, models, and Browser
 * Run. A route inheriting its user's permissions names nothing, so its workflow is inheriting
 * instead: lines to everything its user may call would only bury the ones routes name. Disabled
 * routes grant nothing. A connection is one system per scope and address, by its record in its
 * scope when that scope was read, or else by its address. Connections outside the organization
 * also go by their scope's name, so two scopes' connections to one service tell apart.
 */
export function grantedOutsideSystems({
  organizationId,
  scopes,
  scopeLabel,
}: {
  organizationId: string;
  scopes: readonly GrantingScope[];
  scopeLabel: (scope: BackofficeContextScope) => string;
}): Pick<OrchestrationUniverse, "externals" | "calls" | "inheriting"> {
  const connectionsOf = new Map(
    scopes.map(({ scope, connections }) => [scopeIdentity(scope), connections]),
  );
  const connectionSystem = (
    scope: BackofficeContextScope,
    connectionId: string,
  ): OrchestrationExternal => {
    const scopeId = scopeIdentity(scope);
    const connection = connectionsOf
      .get(scopeId)
      ?.find((candidate) => candidate.connectionId === connectionId);
    const [namespace, localId] = connectionId.includes("#")
      ? connectionId.split(/#(.*)/s, 2)
      : [connectionId, connectionId];
    const name = connection?.displayName ?? localId;
    return {
      id: `connection:${scopeId}|${connectionId}`,
      label: scopeId === organizationId ? name : `${scopeLabel(scope)} · ${name}`,
      icon: (connection && serviceIcon(connection.service)) ?? serviceIcon(namespace) ?? "link",
    };
  };

  const externals = new Map<string, OrchestrationExternal>();
  const calls = new Map<string, OrchestrationExternalCall>();
  const inheriting = new Map<string, OrchestrationInheritingWorkflow>();
  for (const { scope, routes } of scopes) {
    const scopeId = scopeIdentity(scope);
    for (const route of routes) {
      if (!route.enabled || route.action.kind !== "start_workflow") {
        continue;
      }
      const { grants } = route.action.authority;
      const workflowId = workflowTargetId(route.action.workflowScriptPath);
      if (grants === "inherit") {
        inheriting.set(`${scopeId}|${workflowId}`, { scopeId, workflowId });
        continue;
      }
      const reached = grants.flatMap((grant) => {
        if (!("connections" in grant)) {
          const system = PERMISSION_SYSTEMS[grant.namespace];
          return system ? [system] : [];
        }
        return grant.connections.flatMap((connection) => {
          const connectionScope = resolveAutomationGrantedConnectionScope(scope, connection.scope);
          return connectionScope
            ? [connectionSystem(connectionScope, connection.connectionId)]
            : [];
        });
      });
      for (const external of reached) {
        externals.set(external.id, external);
        calls.set(`${scopeId}|${workflowId}|${external.id}`, {
          scopeId,
          workflowId,
          externalId: external.id,
        });
      }
    }
  }
  return {
    externals: [...externals.values()].sort((left, right) => left.label.localeCompare(right.label)),
    calls: [...calls.values()],
    inheriting: [...inheriting.values()],
  };
}
