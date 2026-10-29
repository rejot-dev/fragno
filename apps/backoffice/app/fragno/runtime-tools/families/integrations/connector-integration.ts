import type {
  IntegrationInspection,
  IntegrationSetupProgress,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { jsonValueSchema } from "@fragno-dev/backoffice-api/v0/shared/json";
import {
  BACKOFFICE_PERMISSION,
  type BackofficePermissionRequirement,
} from "@fragno-dev/backoffice-api/v0/shared/permissions";
import { createRouteCaller } from "@fragno-dev/core/api";
import {
  projectConnectorNamedConnectionSchema,
  type ProjectConnectorConnectionState,
  type projectConnectorAccountSchema,
  type projectConnectorConnectionSchema,
} from "@fragno-dev/project-connector-fragment/contracts";
import { z } from "zod";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import {
  BackofficeUnavailableError,
  isBackofficeForbiddenError,
} from "@/backoffice-runtime/kernel";
import { backofficePublicScopePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import type { ProjectConnectorFragment } from "@/fragno/project-connector";
import { projectConnectorPublicAddress } from "@/fragno/scoped-public-fragment-routes";

import {
  isSuccessStatus,
  NotConfiguredError,
  throwOnBackofficeRouteAuthorizationError,
  throwOnRouteRuntimeError,
} from "../../runtime-errors";
import {
  connectorOAuthReturnSegment,
  decodeConnectorConnectionLocalId,
  encodeConnectorConnectionId,
} from "./connector-connection-id";
import {
  compileIntegrationActionSchema,
  describeSchemaViolations,
} from "./integration-action-json-schema";
import type { IntegrationSetupOperation } from "./integration-contracts";
import { connectionStateOfInspection } from "./integration-events";
import type { IntegrationContext, IntegrationImplementation } from "./integration-implementation";

type ConnectorRuntime = Pick<BackofficeRuntimeServices, "objects" | "config">;
type ConnectorAccount = z.output<typeof projectConnectorAccountSchema>;
type ConnectorRequest = z.output<typeof projectConnectorConnectionSchema>;
type ConnectorAddress = ReturnType<typeof decodeConnectorConnectionLocalId>;
const connectorSetupInputSchema = z.strictObject({
  start: z.literal(true).describe("Explicitly start OAuth for this named connection."),
  connectionName: projectConnectorNamedConnectionSchema.shape.connectionName
    .optional()
    .describe(
      "Start under this name instead, such as for another account of the same service; the progress names that connection.",
    ),
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

/** Why the name's latest attempt left it without an account; null when it was never started. */
function describeEndedAttempt(request: ConnectorRequest | null): string | null {
  if (!request) {
    return null;
  }
  switch (request.state.status) {
    case "initiated":
      return null;
    case "failed": {
      const { errorCode, errorMessage } = request.state;
      const code = errorCode ? ` (${errorCode})` : "";
      return `The last OAuth attempt failed${code}${errorMessage ? `: ${errorMessage.replace(/\.$/, "")}` : ""}.`;
    }
    case "expired":
      return "The last OAuth attempt expired before consent completed.";
    case "connected":
      return "Earlier consent no longer has an account under this name.";
    default:
      throw new Error("Connector integration OAuth state is unsupported.", {
        cause: request.state satisfies never,
      });
  }
}

function startInstructions(reason: string | null) {
  return [
    reason,
    reason
      ? "Submit { start: true } to start a new OAuth attempt; it replaces the earlier ones."
      : "Submit { start: true } to start OAuth.",
    "Provider credentials and browser consent remain with the source.",
  ]
    .filter((part) => part !== null)
    .join(" ");
}

/** True when every value the schema accepts is an object, including unions of object variants. */
function describesOnlyObjects(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return false;
  }
  const { type, oneOf, anyOf } = schema as Record<string, unknown>;
  if (type === "object" || (Array.isArray(type) && type.length === 1 && type[0] === "object")) {
    return true;
  }
  if (type !== undefined) {
    return false;
  }
  // Catalogs publish discriminated inputs, such as Notion's update_page_markdown, as a root union.
  const variants = oneOf ?? anyOf;
  return Array.isArray(variants) && variants.length > 0 && variants.every(describesOnlyObjects);
}

function createConnectorActionValidator(schema: Record<string, unknown>) {
  const validator = compileIntegrationActionSchema(schema);
  if (!validator) {
    throw new Error("Connector integration action JSON Schema is invalid or unsupported.");
  }
  return validator;
}

function createConnectorAccess(runtime: ConnectorRuntime, context: IntegrationContext) {
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
  function isAmbiguous(response: Awaited<ReturnType<typeof callRoute>>): boolean {
    return (
      response.type === "error" &&
      response.status === 409 &&
      z.object({ code: z.literal("CONNECTION_AMBIGUOUS") }).safeParse(response.error).success
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
    const response = await invoke(BACKOFFICE_PERMISSION.connections.read, {}, () =>
      callRoute("GET", "/provider-configs"),
    );
    if (response.type === "json" && isSuccessStatus(response.status)) {
      return response.data;
    }
    return fail(response);
  }
  function namedAccount(selector: z.output<typeof projectConnectorNamedConnectionSchema>) {
    return invoke(BACKOFFICE_PERMISSION.connections.read, selector, () =>
      callRoute("GET", "/accounts/by-name", { query: selector }),
    );
  }
  function namedRequest(selector: z.output<typeof projectConnectorNamedConnectionSchema>) {
    return invoke(BACKOFFICE_PERMISSION.connections.manage, selector, () =>
      callRoute("GET", "/connection-requests/by-name", { query: selector }),
    );
  }
  function currentRequestsPage(cursor: string | null) {
    return invoke(BACKOFFICE_PERMISSION.connections.manage, {}, () =>
      callRoute("GET", "/connection-requests/current", {
        query: cursor === null ? {} : { cursor },
      }),
    );
  }
  /** Every saved request across names, pending, ended, and confirmed alike. */
  async function currentRequests(): Promise<ConnectorRequest[]> {
    const requests: ConnectorRequest[] = [];
    let cursor: string | null = null;
    do {
      const response = await currentRequestsPage(cursor);
      if (cursor === null && isNotConfigured(response)) {
        return [];
      }
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return fail(response);
      }
      requests.push(...response.data.requests);
      cursor = response.data.cursor;
    } while (cursor !== null);
    return requests;
  }
  /** Checking never creates consent; the native refresh confirms and persists only gateway evidence. */
  function refresh(requestId: string) {
    return invoke(BACKOFFICE_PERMISSION.connections.manage, { requestId }, () =>
      callRoute("POST", "/connection-requests/:requestId/refresh", {
        pathParams: { requestId },
      }),
    );
  }
  return {
    callRoute,
    invoke,
    fail,
    isNotConfigured,
    isAmbiguous,
    providers,
    namedAccount,
    namedRequest,
    currentRequests,
    refresh,
  };
}

/**
 * Confirms a name's pending consent with the gateway, as a setup check would, so that returning
 * from the provider binds the account without another check. Returns the name's attempt state, or
 * null when the name has no single attempt.
 */
export async function confirmConnectorConsent({
  runtime,
  context,
  address,
}: {
  runtime: ConnectorRuntime;
  context: IntegrationContext;
  address: ConnectorAddress;
}): Promise<ProjectConnectorConnectionState | null> {
  if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
    return null;
  }
  const access = createConnectorAccess(runtime, context);
  const [, projectId, providerConfigId, connectionName] = address;
  const saved = await access.namedRequest({ projectId, providerConfigId, connectionName });
  if (access.isNotConfigured(saved) || access.isAmbiguous(saved)) {
    return null;
  }
  if (saved.type !== "json" || !isSuccessStatus(saved.status)) {
    return access.fail(saved);
  }
  const { request } = saved.data;
  if (request?.state.status !== "initiated") {
    return request?.state ?? null;
  }
  const refreshed = await access.refresh(request.id);
  if (refreshed.type !== "json" || !isSuccessStatus(refreshed.status)) {
    return access.fail(refreshed);
  }
  return refreshed.data.state;
}

/** Projects user-owned OAuth requests and accounts without owning credentials or current-selection state. */
export function createConnectorIntegration({
  runtime,
  nowEpochMs,
}: {
  runtime: ConnectorRuntime;
  nowEpochMs: () => number;
}): IntegrationImplementation {
  /**
   * Brings a name to a confirmed account. A start replaces the name's earlier attempts, and once
   * it confirms, its account replaces the name's others. Reconfigure consents again for a name that
   * has an account; setup reports such a name ready.
   */
  async function runNamedSetup(
    context: IntegrationContext,
    address: ConnectorAddress,
    operation: IntegrationSetupOperation,
    mode: "setup" | "reconfigure",
  ): Promise<IntegrationSetupProgress> {
    const connectionId = encodeConnectorConnectionId(address);
    // Invalid input never selects a connection, not even this one.
    const input =
      operation.kind === "input" ? connectorSetupInputSchema.parse(operation.input) : null;
    if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
      return {
        connectionId,
        status: "blocked",
        reason: "Connector requires an available user-owned configuration store.",
      };
    }
    const [, projectId, providerConfigId, connectionName] = address;
    // Setup input can name another connection of the same provider, which setup continues at.
    if (input?.connectionName !== undefined && input.connectionName !== connectionName) {
      if (mode === "reconfigure") {
        throw new Error(
          "Connector reconfigure keeps the connection name; set up the other name instead.",
        );
      }
      return await runNamedSetup(
        context,
        ["named", projectId, providerConfigId, input.connectionName],
        { kind: "input", input: { start: true } },
        mode,
      );
    }
    const access = createConnectorAccess(runtime, context);
    const selector = { projectId, providerConfigId, connectionName };
    const accountResponse = await access.namedAccount(selector);
    if (access.isNotConfigured(accountResponse)) {
      return {
        connectionId,
        status: "blocked",
        reason:
          "Connector must be configured through its existing server configuration before OAuth setup.",
      };
    }
    let account: ConnectorAccount | null = null;
    let ambiguity: string | null = null;
    if (accountResponse.type === "json" && isSuccessStatus(accountResponse.status)) {
      account = accountResponse.data.account;
    } else if (access.isAmbiguous(accountResponse)) {
      ambiguity = "This name matches several accounts.";
    } else {
      return access.fail(accountResponse);
    }
    const saved = await access.namedRequest(selector);
    let request: ConnectorRequest | null = null;
    if (saved.type === "json" && isSuccessStatus(saved.status)) {
      request = saved.data.request;
    } else if (access.isAmbiguous(saved)) {
      ambiguity ??= "This name matches several OAuth attempts.";
    } else {
      return access.fail(saved);
    }
    if (request?.state.status === "initiated") {
      const refreshed = await access.refresh(request.id);
      if (refreshed.type !== "json" || !isSuccessStatus(refreshed.status)) {
        throwOnBackofficeRouteAuthorizationError(refreshed);
        return {
          connectionId,
          status: "blocked",
          reason: `Connector OAuth confirmation failed (HTTP ${refreshed.status}). The saved request has not been replaced.`,
        };
      }
      request = refreshed.data;
      if (request.state.status === "initiated") {
        // Serial starts reuse the pending link instead of abandoning it.
        return {
          connectionId,
          status: "needs-authorization",
          instructions:
            "Complete browser consent, then check setup again to confirm it with the gateway.",
          authorizationUrl: request.authorizationUrl,
        };
      }
      if (request.state.status === "connected") {
        // The refresh bound the account under this name, replacing any other.
        return { connectionId, status: "ready" };
      }
    }
    if (account && mode === "setup") {
      return { connectionId, status: "ready" };
    }
    const reason = account
      ? [
          request?.state.status === "connected" ? null : describeEndedAttempt(request),
          "The current account stays usable until new consent confirms and replaces it.",
        ]
          .filter((part) => part !== null)
          .join(" ")
      : (ambiguity ?? describeEndedAttempt(request));

    const discovery = await access.providers();
    const provider = discovery.providerConfigs.find(
      (provider) => provider.id === selector.providerConfigId,
    );
    if (discovery.projectId !== selector.projectId || !provider) {
      return {
        connectionId,
        status: "blocked",
        reason: "Connector named setup target does not match the configured project and provider.",
      };
    }
    if (input === null) {
      return {
        connectionId,
        status: "needs-input",
        instructions: startInstructions(reason),
        inputSchema: z.toJSONSchema(connectorSetupInputSchema, { io: "input" }),
        secretFields: [],
      };
    }
    // The return names this connection, so it confirms this attempt alone.
    const returnUri = `${
      projectConnectorPublicAddress(
        runtime.config.docsPublicBaseUrl,
        backofficePublicScopePathSegment(context.execution.scope),
      ).oauthRedirectUri
    }/${connectorOAuthReturnSegment(address)}`;
    const started = await access.invoke(BACKOFFICE_PERMISSION.connections.manage, selector, () =>
      access.callRoute("POST", "/connection-requests", {
        body: {
          providerConfigId: selector.providerConfigId,
          connectionName: selector.connectionName,
          returnUri,
          replace: true,
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
    return {
      connectionId,
      status: "needs-authorization",
      instructions:
        "Complete browser consent, then check setup again to confirm it with the gateway.",
      authorizationUrl: started.data.authorizationUrl,
    };
  }

  return {
    connectionIds: [{ kind: "namespace", namespace: "connector" }],
    setup: {
      kind: "supported",
      run: (context, { localId, operation }) =>
        runNamedSetup(context, decodeConnectorConnectionLocalId(localId), operation, "setup"),
    },
    reconfigure: {
      kind: "supported",
      run: (context, { localId, operation }) =>
        runNamedSetup(context, decodeConnectorConnectionLocalId(localId), operation, "reconfigure"),
    },
    disconnect: {
      kind: "unsupported",
      reason: "The Connector source has no account removal operation.",
    },
    async discover(context) {
      if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
        return [];
      }
      const access = createConnectorAccess(runtime, context);
      let discovery;
      try {
        discovery = await access.providers();
      } catch (cause) {
        // An unconfigured source has no authoritative service identities to publish.
        if (cause instanceof NotConfiguredError) {
          return [];
        }
        throw cause;
      }
      // Names already started, pending or ended, are setup targets too. Reading requests needs
      // connections.manage; without it, discovery offers only the preassigned names.
      let started: ConnectorRequest[] = [];
      try {
        started = await access.currentRequests();
      } catch (cause) {
        if (!isBackofficeForbiddenError(cause)) {
          throw cause;
        }
      }
      const services = [...new Set(discovery.providerConfigs.map((provider) => provider.service))];
      return services.map((service) => ({
        id: service,
        label: service,
        description: `OAuth connections for ${service} using this user's configured project providers. Targets name the default connection and every name already started; to connect another account, submit { start: true, connectionName } to a target's setup.`,
        connectionCardinality: "multiple",
        availability: { status: "available" },
        // This preassigned source name makes a concrete setup target available before OAuth assigns an account ID.
        setupTargets: discovery.providerConfigs
          .filter((provider) => provider.service === service)
          .flatMap((provider) => {
            const names = new Set([service]);
            for (const request of started) {
              if (
                request.projectId === discovery.projectId &&
                request.providerConfigId === provider.id
              ) {
                names.add(request.connectionName);
              }
            }
            return [...names].map((name) => ({
              kind: "connection" as const,
              connectionId: encodeConnectorConnectionId([
                "named",
                discovery.projectId,
                provider.id,
                name,
              ]),
            }));
          }),
        automationEvents: [],
      }));
    },
    async list(context, cursor) {
      if (context.execution.scope.kind !== "user" || !runtime.config.bindings.projectConnector) {
        return { connections: [], cursor: null };
      }
      const access = createConnectorAccess(runtime, context);
      const response = await access.invoke(BACKOFFICE_PERMISSION.connections.read, {}, () =>
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
          authMethod: "oauth",
          ...inspectConnectorAccount(account),
          configuration: { status: "configured" },
        })),
        cursor: response.data.cursor,
      };
    },
    async resolve(context, localId) {
      const address = decodeConnectorConnectionLocalId(localId);
      const access = createConnectorAccess(runtime, context);
      const [, projectId, providerConfigId, name] = address;
      const response = await access.namedAccount({
        projectId,
        providerConfigId,
        connectionName: name,
      });
      if (response.type !== "json" || !isSuccessStatus(response.status)) {
        return access.fail(response);
      }
      const account = response.data.account;
      let service: string;
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
      return {
        identity: {
          connectionId: encodeConnectorConnectionId(address),
          integrationId: service,
          name,
          authMethod: "oauth",
        },
        async inspect() {
          return inspectConnectorAccount(account);
        },
        async state() {
          return connectionStateOfInspection(inspectConnectorAccount(account));
        },
        async details() {
          return {
            kind: "connector",
            projectId,
            providerConfigId,
            connectionName: name,
            accountId: account?.id ?? null,
          };
        },
        // Reconfigure takes only { start: true }; no stored value carries over to new consent.
        async settings() {
          return null;
        },
        async actions() {
          const response = await access.invoke(
            BACKOFFICE_PERMISSION.connections.read,
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
            if (!describesOnlyObjects(action.inputSchema)) {
              throw new Error("Connector integration requires an object action input schema.");
            }
            const inputValidator = createConnectorActionValidator(action.inputSchema);
            const outputValidator = createConnectorActionValidator(action.outputSchema);
            return {
              definition: {
                id: action.id,
                label: action.name,
                description: action.description ?? "",
                validation: { kind: "checked" },
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
                const validation = inputValidator.validate(values);
                if (!validation.valid) {
                  throw new Error(
                    `Connector integration action input failed its published JSON Schema: ${describeSchemaViolations(validation.errors)}`,
                  );
                }
                const result = await access.invoke(
                  BACKOFFICE_PERMISSION.integrations.execute,
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
            BACKOFFICE_PERMISSION.connections.read,
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
