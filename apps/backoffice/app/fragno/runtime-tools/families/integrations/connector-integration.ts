import { createRouteCaller } from "@fragno-dev/core/api";
import {
  projectConnectorNamedConnectionSchema,
  type projectConnectorAccountSchema,
  type projectConnectorConnectionSchema,
} from "@fragno-dev/project-connector-fragment/contracts";
import { z } from "zod";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import { BackofficeUnavailableError } from "@/backoffice-runtime/kernel";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@/backoffice-runtime/permissions";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { ProjectConnectorFragment } from "@/fragno/project-connector";
import { projectConnectorPublicAddress } from "@/fragno/scoped-public-fragment-routes";
import { jsonValueSchema } from "@/lib/zod/json-value";

import {
  isSuccessStatus,
  NotConfiguredError,
  throwOnBackofficeRouteAuthorizationError,
  throwOnRouteRuntimeError,
} from "../../runtime-errors";
import {
  decodeConnectorConnectionLocalId,
  encodeConnectorConnectionId,
} from "./connector-connection-id";
import { compileIntegrationActionSchema } from "./integration-action-json-schema";
import type { IntegrationInspection, IntegrationSetupProgress } from "./integration-contracts";
import type { IntegrationContext, IntegrationImplementation } from "./integration-implementation";

type ConnectorAccount = z.output<typeof projectConnectorAccountSchema>;
const connectorSetupInputSchema = z.strictObject({
  start: z.literal(true).describe("Explicitly start OAuth for this named connection."),
});
const connectorProfileCheck = { id: "account.profile", label: "Read provider profile" };

function inspectConnectorAccount(account: ConnectorAccount | null): IntegrationInspection {
  return {
    configuration: account
      ? { status: "configured" }
      : { status: "missing", missingFields: ["connectedAccount"] },
    authorization: { status: account ? "available" : "missing" },
    checks: [
      {
        ...connectorProfileCheck,
        status: "not-checked",
        reason: account
          ? "No retained live provider profile check is available."
          : "Complete OAuth consent before checking the provider profile.",
      },
    ],
    nextSteps: account ? [] : ["Start OAuth setup and complete browser consent."],
  };
}

function describeConnectorRequest(
  connectionId: string,
  request: z.output<typeof projectConnectorConnectionSchema>,
): IntegrationSetupProgress {
  switch (request.state.status) {
    case "initiated":
      return {
        connectionId,
        status: "needs-authorization",
        instructions:
          "Complete browser consent, then check setup again to confirm it with the gateway.",
        authorizationUrl: request.authorizationUrl,
      };
    case "connected":
      return { connectionId, status: "ready" };
    case "failed":
      return {
        connectionId,
        status: "blocked",
        reason:
          "Connector OAuth failed. Use a fresh connection name for another attempt; historical requests are retained.",
      };
    case "expired":
      return {
        connectionId,
        status: "expired",
        reason:
          "Connector OAuth expired. Use a fresh connection name for another attempt; historical requests are retained.",
      };
    default:
      throw new Error("Connector integration OAuth state is unsupported.", {
        cause: request.state satisfies never,
      });
  }
}

function createConnectorActionValidator(schema: Record<string, unknown>) {
  const validator = compileIntegrationActionSchema(schema);
  if (!validator) {
    throw new Error("Connector integration action JSON Schema is invalid or unsupported.");
  }
  return validator;
}

/** Projects user-owned OAuth requests and accounts without owning credentials or current-selection state. */
export function createConnectorIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: Pick<BackofficeRuntimeServices, "objects" | "config">;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  function createConnectorAccess(context: IntegrationContext) {
    if (context.execution.scope.kind !== "user") {
      throw new BackofficeUnavailableError("Connector integration requires a user scope.");
    }
    if (!runtime.config.bindings.projectConnector) {
      throw new BackofficeUnavailableError("Connector integration object binding is unavailable.");
    }
    const object = context.kernel.scoped(
      "PROJECT_CONNECTOR",
      context.execution.scope,
      runtime.objects.projectConnector,
    );
    const transport = authorizedBackofficeObjectHttp(object.http, context.execution);
    const callRoute = createRouteCaller<ProjectConnectorFragment>({
      baseUrl: "https://project-connector.do",
      mountRoute: "/api/project-connector",
      fetch: transport.fetch.bind(transport),
    });
    function invoke<TResult>(
      operation: BackofficePermissionRequirement,
      resource: Record<string, string>,
      execute: () => Promise<TResult>,
    ) {
      return context.kernel.invoke({
        execution: context.execution,
        operation,
        resource: { capabilityId: "connector", ...resource },
        execute,
      });
    }
    function isNotConfigured(response: Awaited<ReturnType<typeof callRoute>>): boolean {
      return (
        response.type === "error" &&
        response.status === 400 &&
        z.object({ code: z.literal("NOT_CONFIGURED") }).safeParse(response.error).success
      );
    }
    function fail(response: Awaited<ReturnType<typeof callRoute>>): never {
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Connector integration",
        label: "Connector source operation",
        notConfiguredMessage: "Connector is not configured.",
      });
    }
    async function providers() {
      const response = await invoke(BACKOFFICE_PERMISSION.connector.providersRead, {}, () =>
        callRoute("GET", "/provider-configs"),
      );
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return fail(response);
    }
    async function accountById(accountId: string): Promise<ConnectorAccount | null> {
      // The source exposes paged account metadata, not an account-by-ID metadata endpoint.
      // Consume one native page at a time; never infer a provider from an opaque account ID.
      let cursor: string | null = null;
      do {
        const response = await invoke(
          BACKOFFICE_PERMISSION.connector.accountsRead,
          { accountId },
          () => callRoute("GET", "/accounts", { query: cursor === null ? {} : { cursor } }),
        );
        if (response.type !== "json" || !isSuccessStatus(response.status)) {
          return fail(response);
        }
        const account = response.data.accounts.find((account) => account.id === accountId);
        if (account) {
          return account;
        }
        cursor = response.data.cursor;
      } while (cursor !== null);
      return null;
    }
    function namedAccount(selector: z.output<typeof projectConnectorNamedConnectionSchema>) {
      return invoke(BACKOFFICE_PERMISSION.connector.accountsRead, selector, () =>
        callRoute("GET", "/accounts/by-name", { query: selector }),
      );
    }
    return { callRoute, invoke, fail, isNotConfigured, providers, accountById, namedAccount };
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: "connector" }],
    setup: {
      kind: "supported",
      async run(context, { localId, operation }) {
        const address = decodeConnectorConnectionLocalId(localId);
        const connectionId = encodeConnectorConnectionId(address);
        if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
          return {
            connectionId,
            status: "blocked",
            reason: "Connector requires an available user-owned configuration store.",
          };
        }
        const access = createConnectorAccess(context);
        if (address[0] === "account") {
          return (await access.accountById(address[1]))
            ? { connectionId, status: "ready" }
            : {
                connectionId,
                status: "blocked",
                reason:
                  "Connector integration account not found. Select a named OAuth setup target instead.",
              };
        }
        const selector = {
          projectId: address[1],
          providerConfigId: address[2],
          connectionName: address[3],
        };
        const account = await access.namedAccount(selector);
        if (access.isNotConfigured(account)) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "Connector must be configured through its existing server configuration before OAuth setup.",
          };
        }
        if (account.type === "json" && isSuccessStatus(account.status)) {
          if (account.data.account) {
            return { connectionId, status: "ready" };
          }
        } else if (
          account.type === "error" &&
          account.status === 409 &&
          account.error.code === "CONNECTION_AMBIGUOUS"
        ) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "Connector named connection matches multiple accounts. Select an account-ID address instead.",
          };
        } else {
          return access.fail(account);
        }
        const saved = await access.invoke(
          BACKOFFICE_PERMISSION.connector.connectionsCreate,
          selector,
          () => access.callRoute("GET", "/connection-requests/by-name", { query: selector }),
        );
        if (saved.type !== "json" || !isSuccessStatus(saved.status)) {
          if (
            saved.type === "error" &&
            saved.status === 409 &&
            saved.error.code === "CONNECTION_AMBIGUOUS"
          ) {
            return {
              connectionId,
              status: "blocked",
              reason:
                "Connector named connection matches multiple OAuth requests. Use the native request ID or a fresh connection name; no current attempt is inferred.",
            };
          }
          return access.fail(saved);
        }
        const request = saved.data.request;
        if (request) {
          if (request.state.status === "connected") {
            // Retained requests are history: reauthorization can move the same account ID to another name.
            return {
              connectionId,
              status: "blocked",
              reason:
                "Connector OAuth completed, but no current account matches this name. Select the account-ID address or a fresh connection name.",
            };
          }
          if (request.state.status !== "initiated") {
            return describeConnectorRequest(connectionId, request);
          }
          // Checking never creates consent; the native refresh confirms and persists only gateway evidence.
          const refreshed = await access.invoke(
            BACKOFFICE_PERMISSION.connector.connectionsCreate,
            { requestId: request.id },
            () =>
              access.callRoute("POST", "/connection-requests/:requestId/refresh", {
                pathParams: { requestId: request.id },
              }),
          );
          if (refreshed.type === "json" && isSuccessStatus(refreshed.status)) {
            return describeConnectorRequest(connectionId, refreshed.data);
          }
          throwOnBackofficeRouteAuthorizationError(refreshed);
          return {
            connectionId,
            status: "blocked",
            reason: `Connector OAuth confirmation failed (HTTP ${refreshed.status}). The saved request has not been replaced.`,
          };
        }
        const discovery = await access.providers();
        const provider = discovery.providerConfigs.find(
          (provider) => provider.id === selector.providerConfigId,
        );
        if (discovery.projectId !== selector.projectId || !provider) {
          return {
            connectionId,
            status: "blocked",
            reason:
              "Connector named setup target does not match the configured project and provider.",
          };
        }
        if (operation.kind === "check") {
          return {
            connectionId,
            status: "needs-input",
            instructions:
              "Submit { start: true } to start OAuth. Provider credentials and browser consent remain with the source.",
            inputSchema: z.toJSONSchema(connectorSetupInputSchema, { io: "input" }),
            secretFields: [],
          };
        }
        connectorSetupInputSchema.parse(operation.input);
        const returnUri = projectConnectorPublicAddress(
          runtime.config.docsPublicBaseUrl,
          backofficeRouteScopeSinglePathSegment(context.execution.scope),
        ).oauthRedirectUri;
        const started = await access.invoke(
          BACKOFFICE_PERMISSION.connector.connectionsCreate,
          selector,
          () =>
            access.callRoute("POST", "/connection-requests", {
              body: {
                providerConfigId: selector.providerConfigId,
                connectionName: selector.connectionName,
                returnUri,
              },
            }),
        );
        if (started.type !== "json" || !isSuccessStatus(started.status)) {
          return access.fail(started);
        }
        if (
          started.data.projectId !== selector.projectId ||
          started.data.providerConfigId !== selector.providerConfigId ||
          started.data.connectionName !== selector.connectionName ||
          started.data.service !== provider.service
        ) {
          throw new Error(
            "Connector integration OAuth response does not match the named setup target.",
          );
        }
        return describeConnectorRequest(connectionId, started.data);
      },
    },
    reconfigure: {
      kind: "unsupported",
      reason:
        "Connector accounts are not replaced in place. Set up a fresh connection name to consent again; the gateway owns credentials.",
    },
    disconnect: {
      kind: "unsupported",
      reason: "The Connector source has no account removal operation.",
    },
    async discover(context) {
      if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
        return [];
      }
      let discovery;
      try {
        discovery = await createConnectorAccess(context).providers();
      } catch (cause) {
        // An unconfigured source has no authoritative service identities to publish.
        if (cause instanceof NotConfiguredError) {
          return [];
        }
        throw cause;
      }
      const services = [...new Set(discovery.providerConfigs.map((provider) => provider.service))];
      return services.map((service) => ({
        id: service,
        label: service,
        description: `OAuth connections for ${service} using this user's configured project providers.`,
        connectionCardinality: "multiple",
        availability: { status: "available" },
        // This preassigned source name makes a concrete setup target available before OAuth assigns an account ID.
        setupTargets: discovery.providerConfigs
          .filter((provider) => provider.service === service)
          .map((provider) => ({
            kind: "connection",
            connectionId: encodeConnectorConnectionId([
              "named",
              discovery.projectId,
              provider.id,
              "backoffice",
            ]),
          })),
        automationEvents: [],
      }));
    },
    async list(context, cursor) {
      if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
        return { connections: [], cursor: null };
      }
      const access = createConnectorAccess(context);
      const response = await access.invoke(BACKOFFICE_PERMISSION.connector.accountsRead, {}, () =>
        access.callRoute("GET", "/accounts", { query: cursor === null ? {} : { cursor } }),
      );
      if (cursor === null && access.isNotConfigured(response)) {
        return { connections: [], cursor: null };
      }
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return access.fail(response);
      }
      return {
        connections: response.data.accounts.map((account) => ({
          // The named setup address also keys connection events.
          connectionId: encodeConnectorConnectionId([
            "named",
            account.projectId,
            account.providerConfigId,
            account.connectionName,
          ]),
          integrationId: account.service,
          name: account.connectionName,
          ...inspectConnectorAccount(account),
          configuration: { status: "configured" },
        })),
        cursor: response.data.cursor,
      };
    },
    async resolve(context, localId) {
      const address = decodeConnectorConnectionLocalId(localId);
      const access = createConnectorAccess(context);
      let account: ConnectorAccount | null;
      let service: string;
      let name: string;
      let projectId: string;
      let providerConfigId: string;
      if (address[0] === "account") {
        account = await access.accountById(address[1]);
        if (!account) {
          throw new Error("Connector integration account not found.");
        }
        service = account.service;
        name = account.connectionName;
        projectId = account.projectId;
        providerConfigId = account.providerConfigId;
      } else {
        const selector = {
          projectId: address[1],
          providerConfigId: address[2],
          connectionName: address[3],
        };
        const response = await access.namedAccount(selector);
        if (response.type !== "json" || !isSuccessStatus(response.status)) {
          return access.fail(response);
        }
        account = response.data.account;
        projectId = selector.projectId;
        providerConfigId = selector.providerConfigId;
        name = selector.connectionName;
        if (account) {
          service = account.service;
        } else {
          const discovery = await access.providers();
          const provider = discovery.providerConfigs.find(
            (provider) => provider.id === providerConfigId,
          );
          if (discovery.projectId !== projectId || !provider) {
            throw new Error("Connector integration named connection not found.");
          }
          service = provider.service;
        }
      }
      return {
        identity: {
          connectionId: encodeConnectorConnectionId(address),
          integrationId: service,
          name,
        },
        async inspect() {
          return inspectConnectorAccount(account);
        },
        async actions() {
          const response = await access.invoke(
            BACKOFFICE_PERMISSION.connector.providersRead,
            { providerConfigId },
            () =>
              access.callRoute("GET", "/provider-configs/:providerConfigId/actions", {
                pathParams: { providerConfigId },
              }),
          );
          if (response.type !== "json" || !isSuccessStatus(response.status)) {
            return access.fail(response);
          }
          if (
            response.data.projectId !== projectId ||
            response.data.providerConfigId !== providerConfigId ||
            response.data.actions.some((action) => action.service !== service)
          ) {
            throw new Error(
              "Connector integration action discovery does not match the selected source connection.",
            );
          }
          return response.data.actions.map((action) => {
            // The native execution route accepts objects; publishing a scalar contract would promise an unusable action.
            const inputType = action.inputSchema.type;
            if (
              inputType !== "object" &&
              !(Array.isArray(inputType) && inputType.length === 1 && inputType[0] === "object")
            ) {
              throw new Error("Connector integration requires an object action input schema.");
            }
            const inputValidator = createConnectorActionValidator(action.inputSchema);
            const outputValidator = createConnectorActionValidator(action.outputSchema);
            return {
              definition: {
                id: action.id,
                label: action.name,
                description: action.description ?? "",
                inputSchema: action.inputSchema,
                outputSchema: action.outputSchema,
              },
              async invoke(input) {
                if (!account) {
                  throw new Error(
                    "Connector integration requires a confirmed account before action execution.",
                  );
                }
                const values = z.record(z.string(), jsonValueSchema).parse(input);
                if (!inputValidator.validate(values).valid) {
                  throw new Error(
                    "Connector integration action input failed its published JSON Schema.",
                  );
                }
                const result = await access.invoke(
                  BACKOFFICE_PERMISSION.connector.actionsExecute,
                  { accountId: account.id, actionId: action.id },
                  () =>
                    access.callRoute("POST", "/accounts/:accountId/actions/:actionId", {
                      pathParams: { accountId: account.id, actionId: action.id },
                      body: { input: values },
                    }),
                );
                if (result.type !== "json" || !isSuccessStatus(result.status)) {
                  return access.fail(result);
                }
                if (result.data.actionId !== action.id) {
                  throw new Error(
                    "Connector integration action response has a different action identity.",
                  );
                }
                const output = jsonValueSchema.parse(result.data.output);
                if (!outputValidator.validate(output).valid) {
                  throw new Error(
                    "Connector integration action output failed its published JSON Schema. The action has already run and must not be automatically retried.",
                  );
                }
                return output;
              },
            };
          });
        },
        async verify() {
          const inspection = inspectConnectorAccount(account);
          if (!account) {
            return inspection;
          }
          const response = await access.invoke(
            BACKOFFICE_PERMISSION.connector.accountsRead,
            { accountId: account.id },
            () =>
              access.callRoute("GET", "/accounts/:accountId/profile", {
                pathParams: { accountId: account.id },
              }),
          );
          throwOnBackofficeRouteAuthorizationError(response);
          const passed = response.type === "json" && isSuccessStatus(response.status);
          return {
            ...inspection,
            checks: [
              {
                ...connectorProfileCheck,
                status: passed ? "passed" : "failed",
                checkedAt: new Date(nowEpochMs()).toISOString(),
                message: passed
                  ? "Connector read the provider profile. Provider actions and their scopes have not been tested."
                  : `Connector provider profile check failed (HTTP ${response.status}).`,
              },
            ],
            nextSteps: passed
              ? []
              : [
                  "Check provider authorization through the source controls and retry verification.",
                ],
          };
        },
      };
    },
  };
}
