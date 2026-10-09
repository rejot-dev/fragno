import { decodeCursor, type Cursor } from "@fragno-dev/db/cursor";
import { z } from "zod";

import { defineRoutes } from "@fragno-dev/core";

import { projectConnectorFragmentDefinition } from "./definition";
import {
  confirmProjectConnectorRequest,
  ProjectConnectorClientError,
} from "./project-connector-client";
import {
  projectConnectorAccountsSchema,
  projectConnectorNamedConnectionSchema,
  projectConnectorNamedRequestSchema,
  projectConnectorNamedAccountSchema,
  projectConnectorStatusSchema,
  projectConnectorProviderConfigsSchema,
  projectConnectorProviderActionsSchema,
  projectConnectorConnectInputSchema,
  projectConnectorConnectionSchema,
  projectConnectorProfileSchema,
  projectConnectorExecutionSchema,
  type ProjectConnectorConnectionState,
} from "./project-connector-contracts";
import { projectConnectorSchema } from "./schema";

function serializeProjectConnectorRequest(
  saved: Omit<z.output<typeof projectConnectorConnectionSchema>, "id"> & {
    id: { toString(): string };
  },
): z.output<typeof projectConnectorConnectionSchema> {
  return {
    id: saved.id.toString(),
    projectId: saved.projectId,
    providerConfigId: saved.providerConfigId,
    externalUserId: saved.externalUserId,
    service: saved.service,
    connectionName: saved.connectionName,
    authorizationUrl: saved.authorizationUrl,
    expiresAt: saved.expiresAt,
    state: saved.state,
  };
}

/** Authenticated routes never accept a product user ID or account binding from the browser. */
export const projectConnectorRoutes = defineRoutes(projectConnectorFragmentDefinition).create(
  ({ config, deps, defineRoute }) => [
    defineRoute({
      method: "GET",
      path: "/provider-configs",
      outputSchema: projectConnectorProviderConfigsSchema,
      errorCodes: ["UNAUTHENTICATED", "PROJECT_CONNECTOR_ERROR"],
      handler: async function ({ headers }, { json, error }) {
        if (!(await config.getExternalUserId(headers))) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        try {
          return json(await deps.projectConnector.listProviderConfigs());
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/provider-configs/:providerConfigId/actions",
      outputSchema: projectConnectorProviderActionsSchema,
      errorCodes: ["UNAUTHENTICATED", "PROVIDER_CONFIG_NOT_FOUND", "PROJECT_CONNECTOR_ERROR"],
      handler: async function ({ headers, pathParams }, { json, error }) {
        if (!(await config.getExternalUserId(headers))) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        try {
          const actions = await deps.projectConnector.listProviderActions(
            pathParams.providerConfigId,
          );
          if (!actions) {
            return error(
              {
                code: "PROVIDER_CONFIG_NOT_FOUND",
                message: "Provider configuration not found",
              },
              404,
            );
          }
          return json(actions);
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/status",
      outputSchema: projectConnectorStatusSchema,
      errorCodes: ["UNAUTHENTICATED", "PROJECT_CONNECTOR_ERROR"],
      handler: async function ({ headers }, { json, error }) {
        if (!(await config.getExternalUserId(headers))) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        try {
          return json(await deps.projectConnector.check());
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/connection-requests",
      inputSchema: projectConnectorConnectInputSchema,
      outputSchema: projectConnectorConnectionSchema,
      errorCodes: ["UNAUTHENTICATED", "RETURN_URI_NOT_ALLOWED", "PROJECT_CONNECTOR_ERROR"],
      handler: async function ({ headers, input }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        const body = await input.valid();
        if (!config.allowedReturnUrls(new URL(body.returnUri))) {
          return error(
            { code: "RETURN_URI_NOT_ALLOWED", message: "OAuth return URL is not allowed" },
            400,
          );
        }
        try {
          const remote = await deps.projectConnector.connect(externalUserId, body);
          if (
            remote.externalUserId !== externalUserId ||
            remote.connectionName !== body.connectionName ||
            ("providerConfigId" in body
              ? remote.providerConfigId !== body.providerConfigId
              : remote.service !== body.service)
          ) {
            throw new ProjectConnectorClientError("connection_identity_mismatch", 502);
          }
          const connection = {
            id: remote.id,
            projectId: remote.projectId,
            providerConfigId: remote.providerConfigId,
            externalUserId,
            service: remote.service,
            connectionName: remote.connectionName,
            authorizationUrl: remote.authorizationUrl,
            expiresAt: remote.expiresAt,
            state: { status: "initiated" as const },
          };
          const named = {
            projectId: remote.projectId,
            providerConfigId: remote.providerConfigId,
            connectionName: body.connectionName,
          };
          await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(projectConnectorSchema).findFirst("connectedAccount", (b) =>
                b.whereIndex("idx_account_named_connection", (eb) =>
                  eb.and(
                    eb("externalUserId", "=", externalUserId),
                    eb("projectId", "=", named.projectId),
                    eb("providerConfigId", "=", named.providerConfigId),
                    eb("connectionName", "=", named.connectionName),
                  ),
                ),
              ),
            )
            .mutate(({ forSchema, retrieveResult: [account] }) => {
              const uow = forSchema(projectConnectorSchema);
              uow.create("connectionRequest", connection);
              // Another attempt leaves a name that already has a confirmed account ready.
              if (!account) {
                uow.triggerHook("onConnectionReadinessChanged", {
                  externalUserId,
                  service: remote.service,
                  connection: named,
                  ready: false,
                });
              }
            })
            .execute();
          return json(connection);
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/connection-requests/by-name",
      queryParameters: ["projectId", "providerConfigId", "connectionName"],
      outputSchema: projectConnectorNamedRequestSchema,
      errorCodes: ["UNAUTHENTICATED", "INVALID_SELECTOR", "CONNECTION_AMBIGUOUS"],
      handler: async function ({ headers, query }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        const selector = projectConnectorNamedConnectionSchema.safeParse({
          projectId: query.get("projectId"),
          providerConfigId: query.get("providerConfigId"),
          connectionName: query.get("connectionName"),
        });
        if (!selector.success) {
          return error(
            { code: "INVALID_SELECTOR", message: "Invalid named connection selector" },
            400,
          );
        }
        const [page] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(projectConnectorSchema).findWithCursor("connectionRequest", (b) =>
              b
                .whereIndex("idx_request_named_connection", (eb) =>
                  eb.and(
                    eb("externalUserId", "=", externalUserId),
                    eb("projectId", "=", selector.data.projectId),
                    eb("providerConfigId", "=", selector.data.providerConfigId),
                    eb("connectionName", "=", selector.data.connectionName),
                  ),
                )
                .orderByIndex("idx_request_named_connection", "asc")
                .pageSize(2),
            ),
          )
          .execute();
        if (page.items.length > 1) {
          return error(
            {
              code: "CONNECTION_AMBIGUOUS",
              message: "Project Connector named connection matches multiple OAuth requests.",
            },
            409,
          );
        }
        const [saved] = page.items;
        return json({ request: saved ? serializeProjectConnectorRequest(saved) : null });
      },
    }),
    defineRoute({
      method: "POST",
      path: "/connection-requests/:requestId/refresh",
      outputSchema: projectConnectorConnectionSchema,
      errorCodes: ["UNAUTHENTICATED", "REQUEST_NOT_FOUND", "PROJECT_CONNECTOR_ERROR"],
      handler: async function ({ headers, pathParams }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        let confirmed: ProjectConnectorConnectionState | null = null;
        try {
          const result = await this.handlerTx()
            .retrieve(({ forSchema }) =>
              forSchema(projectConnectorSchema)
                .findFirst("connectionRequest", (b) =>
                  b.whereIndex("primary", (eb) => eb("id", "=", pathParams.requestId)),
                )
                // Confirmation supplies the account ID later; acquire owned IDs in the single read phase.
                .find("connectedAccount", (b) =>
                  b
                    .whereIndex("idx_account_external_user_id", (eb) =>
                      eb("externalUserId", "=", externalUserId),
                    )
                    .select(["id", "projectId", "providerConfigId", "connectionName"]),
                ),
            )
            .afterRetrieve(async (_uow, [saved]) => {
              // OCC retries must not reuse a confirmation prepared for an older snapshot.
              confirmed = null;
              if (
                !saved ||
                saved.externalUserId !== externalUserId ||
                saved.state.status !== "initiated"
              ) {
                return;
              }
              const remote = await deps.projectConnector.getConnectionRequest(saved.id.toString());
              confirmed = confirmProjectConnectorRequest(
                { ...saved, id: saved.id.toString() },
                remote,
              );
            })
            .mutate(({ forSchema, retrieveResult: [saved, accounts] }) => {
              if (!saved || saved.externalUserId !== externalUserId) {
                return null;
              }
              const state = confirmed ?? saved.state;
              const uow = forSchema(projectConnectorSchema);
              if (saved.state.status === "initiated" && state.status !== "initiated") {
                uow.update("connectionRequest", saved.id, (b) => b.set({ state }).check());
                if (state.status === "connected") {
                  const existing = accounts.find(
                    (account) => account.id.toString() === state.connectedAccountId,
                  );
                  // Reauthorization replaces only the same owned account ID, not other accounts sharing its name.
                  if (existing) {
                    uow.delete("connectedAccount", existing.id, (b) => b.check());
                  }
                  // An incoming ID belonging to another user must fail the create, never replace their binding.
                  uow.create("connectedAccount", {
                    id: state.connectedAccountId,
                    projectId: saved.projectId,
                    providerConfigId: saved.providerConfigId,
                    externalUserId: saved.externalUserId,
                    service: saved.service,
                    connectionName: saved.connectionName,
                  });
                  const wasReady = accounts.some(
                    (account) =>
                      account.projectId === saved.projectId &&
                      account.providerConfigId === saved.providerConfigId &&
                      account.connectionName === saved.connectionName,
                  );
                  if (!wasReady) {
                    uow.triggerHook("onConnectionReadinessChanged", {
                      externalUserId,
                      service: saved.service,
                      connection: {
                        projectId: saved.projectId,
                        providerConfigId: saved.providerConfigId,
                        connectionName: saved.connectionName,
                      },
                      ready: true,
                    });
                  }
                }
              }
              return serializeProjectConnectorRequest({ ...saved, state });
            })
            .execute();
          if (!result) {
            return error(
              { code: "REQUEST_NOT_FOUND", message: "Connection request not found" },
              404,
            );
          }
          return json(result);
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
    defineRoute({
      method: "GET",
      path: "/accounts",
      queryParameters: ["cursor"],
      outputSchema: projectConnectorAccountsSchema,
      errorCodes: ["UNAUTHENTICATED", "INVALID_CURSOR"],
      handler: async function ({ headers, query }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        let cursor: Cursor | null = null;
        const rawCursor = query.get("cursor");
        if (rawCursor) {
          try {
            cursor = decodeCursor(rawCursor);
            const accountId = cursor.indexValues["id"];
            if (
              cursor.indexName !== "idx_account_external_user_id" ||
              cursor.orderDirection !== "asc" ||
              cursor.pageSize !== 25 ||
              cursor.indexValues["externalUserId"] !== externalUserId ||
              typeof accountId !== "string" ||
              accountId.length === 0
            ) {
              throw new Error("Account cursor does not match this user or query");
            }
          } catch {
            return error({ code: "INVALID_CURSOR", message: "Invalid account cursor" }, 400);
          }
        }
        const [page] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(projectConnectorSchema).findWithCursor("connectedAccount", (b) => {
              const ordered = b
                .whereIndex("idx_account_external_user_id", (eb) =>
                  eb("externalUserId", "=", externalUserId),
                )
                .orderByIndex("idx_account_external_user_id", "asc")
                .pageSize(25);
              return cursor ? ordered.after(cursor) : ordered;
            }),
          )
          .execute();
        return json({
          accounts: page.items.map((account) => ({
            id: account.id.toString(),
            projectId: account.projectId,
            providerConfigId: account.providerConfigId,
            externalUserId: account.externalUserId,
            service: account.service,
            connectionName: account.connectionName,
          })),
          cursor: page.cursor?.encode() ?? null,
          hasNextPage: page.hasNextPage,
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/accounts/by-name",
      queryParameters: ["projectId", "providerConfigId", "connectionName"],
      outputSchema: projectConnectorNamedAccountSchema,
      errorCodes: ["UNAUTHENTICATED", "INVALID_SELECTOR", "CONNECTION_AMBIGUOUS"],
      handler: async function ({ headers, query }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        const selector = projectConnectorNamedConnectionSchema.safeParse({
          projectId: query.get("projectId"),
          providerConfigId: query.get("providerConfigId"),
          connectionName: query.get("connectionName"),
        });
        if (!selector.success) {
          return error(
            { code: "INVALID_SELECTOR", message: "Invalid named connection selector" },
            400,
          );
        }
        const [page] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(projectConnectorSchema).findWithCursor("connectedAccount", (b) =>
              b
                .whereIndex("idx_account_named_connection", (eb) =>
                  eb.and(
                    eb("externalUserId", "=", externalUserId),
                    eb("projectId", "=", selector.data.projectId),
                    eb("providerConfigId", "=", selector.data.providerConfigId),
                    eb("connectionName", "=", selector.data.connectionName),
                  ),
                )
                .orderByIndex("idx_account_named_connection", "asc")
                .pageSize(2),
            ),
          )
          .execute();
        if (page.items.length > 1) {
          return error(
            {
              code: "CONNECTION_AMBIGUOUS",
              message: "Project Connector named connection matches multiple confirmed accounts.",
            },
            409,
          );
        }
        const [account] = page.items;
        return json({
          account: account
            ? {
                id: account.id.toString(),
                projectId: account.projectId,
                providerConfigId: account.providerConfigId,
                externalUserId: account.externalUserId,
                service: account.service,
                connectionName: account.connectionName,
              }
            : null,
        });
      },
    }),
    defineRoute({
      method: "GET",
      path: "/accounts/:accountId/profile",
      outputSchema: projectConnectorProfileSchema,
      errorCodes: ["UNAUTHENTICATED", "ACCOUNT_NOT_FOUND", "PROJECT_CONNECTOR_ERROR"],
      handler: async function ({ headers, pathParams }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        const [account] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(projectConnectorSchema).findFirst("connectedAccount", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", pathParams.accountId)),
            ),
          )
          .execute();
        if (!account || account.externalUserId !== externalUserId) {
          return error({ code: "ACCOUNT_NOT_FOUND", message: "Connected account not found" }, 404);
        }
        try {
          const profile = await deps.projectConnector.getProfile(account.id.toString());
          if (
            profile.connectedAccountId !== account.id.toString() ||
            profile.externalUserId !== externalUserId ||
            profile.service !== account.service
          ) {
            throw new ProjectConnectorClientError("account_identity_mismatch", 502);
          }
          return json(profile);
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
    defineRoute({
      method: "POST",
      path: "/accounts/:accountId/actions/:actionId",
      inputSchema: z.strictObject({ input: z.record(z.string(), z.unknown()) }),
      outputSchema: projectConnectorExecutionSchema,
      errorCodes: [
        "UNAUTHENTICATED",
        "ACCOUNT_NOT_FOUND",
        "ACTION_SERVICE_MISMATCH",
        "PROJECT_CONNECTOR_ERROR",
      ],
      handler: async function ({ headers, pathParams, input }, { json, error }) {
        const externalUserId = await config.getExternalUserId(headers);
        if (!externalUserId) {
          return error({ code: "UNAUTHENTICATED", message: "Authentication required" }, 401);
        }
        const body = await input.valid();
        const [account] = await this.handlerTx()
          .retrieve(({ forSchema }) =>
            forSchema(projectConnectorSchema).findFirst("connectedAccount", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", pathParams.accountId)),
            ),
          )
          .execute();
        if (!account || account.externalUserId !== externalUserId) {
          return error({ code: "ACCOUNT_NOT_FOUND", message: "Connected account not found" }, 404);
        }
        if (
          !pathParams.actionId.startsWith(`${account.service}.`) ||
          !/^[a-z0-9_-]+\.[a-z0-9_-]+$/.test(pathParams.actionId)
        ) {
          return error(
            {
              code: "ACTION_SERVICE_MISMATCH",
              message: "Action must belong to the connected account service",
            },
            400,
          );
        }
        try {
          return json(
            await deps.projectConnector.execute(
              { ...account, id: account.id.toString() },
              pathParams.actionId,
              body.input,
            ),
          );
        } catch (cause) {
          if (!(cause instanceof ProjectConnectorClientError)) {
            throw cause;
          }
          return error({ code: "PROJECT_CONNECTOR_ERROR", message: cause.message }, 502);
        }
      },
    }),
  ],
);
