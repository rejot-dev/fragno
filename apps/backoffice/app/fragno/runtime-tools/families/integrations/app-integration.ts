import type { AppActionTokenClaims } from "@fragno-dev/backoffice-api/v0/app-actions";
import type { BackofficeApp } from "@fragno-dev/backoffice-api/v0/apps";
import type {
  IntegrationConnection,
  IntegrationInspection,
} from "@fragno-dev/backoffice-api/v0/integrations";

import { isBackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import { BackofficeOperationError } from "@/backoffice-runtime/operation-error";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  appInstallationResourceScopeContains,
  appInstallationTargetScope,
  type AppInstallationTargetScope,
  type BackofficeAppConnection,
} from "@/fragno/app-installations/contracts";
import { requireBackofficeAppOperationValue } from "@/fragno/apps/errors";

import { compileIntegrationActionSchema } from "./integration-action-json-schema";
import { connectionStateOfInspection, type IntegrationConnectionState } from "./integration-events";
import type {
  IntegrationActionImplementation,
  IntegrationContext,
  IntegrationImplementation,
} from "./integration-implementation";

const APP_CONNECTION_NAMESPACE = "app";
const APP_INTEGRATION_ID = "app";
const APP_LIST_PAGE_SIZE = 25;
const appEndpointCheck = { id: "endpoint.ping", label: "Reach the app's action endpoint" };

const installationSetupReason =
  "Installing the app is its setup: review it with apps.get and install it with apps.install, or start from the app's own connect flow.";

export function encodeAppConnectionId(slug: string) {
  return `${APP_CONNECTION_NAMESPACE}#${slug}`;
}

type AppScope = AppInstallationTargetScope;

function appScopeOf(context: IntegrationContext): AppScope | null {
  return appInstallationTargetScope(context.execution.scope);
}

/** The app learns which user is behind a call; automated work calls as the installation. */
function actorOf(context: IntegrationContext): AppActionTokenClaims["actor"] {
  const principal = context.execution.actors.principal;
  return principal?.scope === "internal" && principal.type === "user"
    ? { kind: "user", userId: principal.id }
    : { kind: "installation" };
}

/** Installed actions in this scope, or null when the connection cannot call any. */
function callableActions(connection: BackofficeAppConnection, scope: AppScope) {
  if (
    connection.status !== "installed" ||
    !appInstallationResourceScopeContains(connection.installation.resourceScope, scope) ||
    connection.actions.kind === "none"
  ) {
    return null;
  }
  return connection.actions;
}

function inspectAppConnection(
  connection: BackofficeAppConnection,
  scope: AppScope,
): IntegrationInspection {
  const notChecked = (reason: string) => [
    { ...appEndpointCheck, status: "not-checked" as const, reason },
  ];
  if (connection.status !== "installed") {
    return {
      configuration: { status: "missing", missingFields: ["installation"] },
      authorization: { status: "missing" },
      checks: notChecked("The app is not installed in this organization."),
      nextSteps: [installationSetupReason],
    };
  }
  const { installation, actions, pendingActionsRevision } = connection;
  const approvalSteps =
    pendingActionsRevision === null
      ? []
      : [
          `The app's actions changed (revision ${pendingActionsRevision}). Review them with apps.get and approve them with apps.installations.approveActions to run new or changed actions; until then the approved actions run.`,
        ];
  if (!appInstallationResourceScopeContains(installation.resourceScope, scope)) {
    return {
      configuration: { status: "missing", missingFields: ["installation"] },
      authorization: { status: "missing" },
      checks: notChecked("The installation does not include this project."),
      nextSteps: [
        "The installation does not include this project; widen it with apps.installations.update.",
      ],
    };
  }
  if (actions.kind === "none") {
    return {
      configuration: { status: "missing", missingFields: ["actions"] },
      authorization: { status: "not-required" },
      checks: notChecked("The installation has no approved actions."),
      nextSteps: approvalSteps.length > 0 ? approvalSteps : ["This app declares no actions."],
    };
  }
  if (installation.externalAccount === null) {
    return {
      configuration: { status: "configured" },
      authorization: { status: "missing" },
      checks: notChecked("The app has not linked the installation to one of its accounts."),
      nextSteps: [
        "The app has not linked this installation to one of its accounts; finish the app's connect flow.",
        ...approvalSteps,
      ],
    };
  }
  return {
    configuration: { status: "configured" },
    authorization: { status: "available" },
    checks: notChecked("Run integrations.verify to ping the app's endpoint."),
    nextSteps: approvalSteps,
  };
}

/** The OAuth client's name is what members saw when they installed the app. */
export async function appConnectionName(
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">,
  app: BackofficeApp,
) {
  if (!runtime.config.bindings.auth) {
    return app.slug;
  }
  const client = await runtime.objects.auth
    .singleton()
    .commands.getOAuthClientFacts({ clientId: app.oauthClientId });
  return client?.name ?? app.slug;
}

/**
 * The state integrations.connection.* events report for an app connection in one scope. Outside
 * the installation's resources, or once uninstalled, the connection no longer exists there.
 */
export function appConnectionState(
  connection: BackofficeAppConnection,
  scope: AppScope,
): IntegrationConnectionState | "disconnected" {
  if (
    connection.status !== "installed" ||
    !appInstallationResourceScopeContains(connection.installation.resourceScope, scope)
  ) {
    return "disconnected";
  }
  return connectionStateOfInspection(inspectAppConnection(connection, scope));
}

/**
 * Installed apps whose registration declares actions. Installing the app is the setup, and the
 * actions run on the app's own server, signed by Backoffice for each call.
 */
export function createAppIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  function installationsFor(context: IntegrationContext, scope: AppScope) {
    // Installations are approved by Auth users, so apps exist only where Auth does.
    if (!runtime.config.bindings.auth) {
      return null;
    }
    try {
      return context.kernel.scoped(
        "APP_INSTALLATIONS",
        scope.kind === "org" ? scope : scope.owner,
        runtime.objects.appInstallations,
      ).commands;
    } catch (error) {
      if (isBackofficeUnavailableError(error)) {
        return null;
      }
      throw error;
    }
  }

  function requireAccess(context: IntegrationContext) {
    const scope = appScopeOf(context);
    const installations = scope === null ? null : installationsFor(context, scope);
    if (scope === null || installations === null) {
      throw new BackofficeOperationError(
        "not_found",
        "App connections exist only in organizations and their projects.",
      );
    }
    return { scope, installations };
  }

  async function appName(connection: BackofficeAppConnection, slug: string) {
    return connection.status === "installed"
      ? await appConnectionName(runtime, connection.app)
      : slug;
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: APP_CONNECTION_NAMESPACE }],
    setup: { kind: "unsupported", reason: installationSetupReason },
    reconfigure: {
      kind: "unsupported",
      reason:
        "Change the installation's access with apps.installations.update and approve changed actions with apps.installations.approveActions.",
    },
    disconnect: {
      kind: "unsupported",
      reason: "Uninstall the app with apps.uninstall; it revokes the app's access as well.",
    },
    async discover(context) {
      const scope = appScopeOf(context);
      const available = scope !== null && installationsFor(context, scope) !== null;
      return [
        {
          id: APP_INTEGRATION_ID,
          label: "Installed apps",
          description:
            "Actions that installed apps declare and serve on their own servers. Each installed app with actions is one connection, addressed as app#<slug> with the slug apps.get shows; installing the app is its setup.",
          connectionCardinality: "multiple",
          availability: available
            ? { status: "available" }
            : {
                status: "unavailable",
                reason: "Apps are installed in organizations and act in their projects.",
              },
          setupTargets: [],
          automationEvents: [],
        },
      ];
    },
    async list(context, cursor) {
      const scope = appScopeOf(context);
      const installations = scope === null ? null : installationsFor(context, scope);
      if (scope === null || installations === null) {
        return { connections: [], cursor: null };
      }
      const page = requireBackofficeAppOperationValue(
        await installations.listInstallations({ pageSize: APP_LIST_PAGE_SIZE, cursor }),
      );
      const connections = await Promise.all(
        page.installations
          .filter((installation) => installation.status === "active")
          .map(async ({ appId }) => {
            const connection = await installations.getAppConnection({ appId });
            // Listing shows connections with callable actions; integrations.get explains the rest.
            if (connection.status !== "installed" || callableActions(connection, scope) === null) {
              return null;
            }
            const listed: IntegrationConnection & { configuration: { status: "configured" } } = {
              connectionId: encodeAppConnectionId(connection.app.slug),
              integrationId: APP_INTEGRATION_ID,
              name: await appName(connection, connection.app.slug),
              authMethod: "app-installation",
              ...inspectAppConnection(connection, scope),
              configuration: { status: "configured" },
            };
            return listed;
          }),
      );
      return {
        connections: connections.filter((connection) => connection !== null),
        cursor: page.nextCursor,
      };
    },
    async resolve(context, slug) {
      const { scope, installations } = requireAccess(context);
      const app = await runtime.objects.apps.singleton().commands.getAppBySlug({ slug });
      // An unknown slug reads as an app this organization has not installed.
      const appId = app?.id ?? null;
      const connection: BackofficeAppConnection =
        appId === null
          ? { status: "not-installed" }
          : await installations.getAppConnection({ appId });
      const identity = {
        connectionId: encodeAppConnectionId(slug),
        integrationId: APP_INTEGRATION_ID,
        name: await appName(connection, slug),
        authMethod: "app-installation",
      } as const;
      const inspect = async () => inspectAppConnection(connection, scope);
      const call = async (
        request: Parameters<typeof installations.callAppEndpoint>[0]["request"],
      ) => {
        // Actions and verification call only installed apps, so this guards an unknown slug.
        if (appId === null) {
          throw new BackofficeOperationError("not_found", `App '${slug}' is not registered.`);
        }
        return requireBackofficeAppOperationValue(
          await installations.callAppEndpoint({
            appId,
            scopeRestriction: scope,
            actor: actorOf(context),
            request,
          }),
        );
      };
      return {
        identity,
        inspect,
        state: async () => connectionStateOfInspection(await inspect()),
        details: async () => ({ kind: "native" }),
        // The installation, not a stored configuration, is what changes this connection.
        settings: async () => null,
        async actions() {
          const actions = callableActions(connection, scope);
          if (actions === null) {
            return [];
          }
          return actions.actions.map((action): IntegrationActionImplementation => {
            // Registration rejects contracts the compiler cannot enforce.
            const input = compileIntegrationActionSchema(action.inputSchema);
            const output = compileIntegrationActionSchema(action.outputSchema);
            return {
              definition: {
                id: action.id,
                label: action.label,
                description: action.description,
                validation: { kind: "checked" },
                inputSchema: action.inputSchema,
                outputSchema: action.outputSchema,
              },
              async invoke(value) {
                if (!input?.validate(value).valid) {
                  throw new BackofficeOperationError(
                    "invalid_request",
                    `App action '${action.id}' input failed its declared JSON Schema.`,
                  );
                }
                const response = await call({ type: "action", actionId: action.id, input: value });
                if (response.status < 200 || response.status >= 300) {
                  const message =
                    response.body !== null &&
                    typeof response.body === "object" &&
                    !Array.isArray(response.body) &&
                    typeof response.body.message === "string"
                      ? `: ${response.body.message}`
                      : ".";
                  throw new BackofficeOperationError(
                    "operation_failed",
                    `App action '${action.id}' failed with HTTP ${response.status}${message}`,
                  );
                }
                if (response.body === null || !output?.validate(response.body).valid) {
                  throw new BackofficeOperationError(
                    "operation_failed",
                    `App action '${action.id}' returned output that failed its declared schema. The action has already run and must not be automatically retried.`,
                  );
                }
                return response.body;
              },
            };
          });
        },
        async verify() {
          const inspection = await inspect();
          if (
            inspection.configuration.status === "missing" ||
            inspection.authorization.status !== "available"
          ) {
            return inspection;
          }
          const response = await call({ type: "ping" });
          const passed = response.status >= 200 && response.status < 300;
          return {
            ...inspection,
            checks: [
              {
                ...appEndpointCheck,
                status: passed ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message: passed
                  ? "The app accepted a signed ping."
                  : `The app answered a signed ping with HTTP ${response.status}.`,
              },
            ],
          };
        },
      };
    },
  };
}
