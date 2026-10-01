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
  projectConnectorStatusSchema,
  projectConnectorConnectInputSchema,
  projectConnectorConnectionSchema,
  projectConnectorProfileSchema,
  projectConnectorExecutionSchema,
  type ProjectConnectorConnectionState,
} from "./project-connector-contracts";
import { projectConnectorSchema } from "./schema";

/** Authenticated routes never accept a product user ID or account binding from the browser. */
export const projectConnectorRoutes = defineRoutes(projectConnectorFragmentDefinition).create(
  ({ config, deps, defineRoute }) => [
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
          await this.handlerTx()
            .mutate(({ forSchema }) => {
              forSchema(projectConnectorSchema).create("connectionRequest", connection);
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
              forSchema(projectConnectorSchema).findFirst("connectionRequest", (b) =>
                b.whereIndex("primary", (eb) => eb("id", "=", pathParams.requestId)),
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
            .mutate(({ forSchema, retrieveResult: [saved] }) => {
              if (!saved || saved.externalUserId !== externalUserId) {
                return null;
              }
              const state = confirmed ?? saved.state;
              const uow = forSchema(projectConnectorSchema);
              if (saved.state.status === "initiated" && state.status !== "initiated") {
                uow.update("connectionRequest", saved.id, (b) => b.set({ state }).check());
                if (state.status === "connected") {
                  // Reauthorization can return an existing account. Upstream identity is
                  // already verified; an idempotent binding must not duplicate the row.
                  uow.delete("connectedAccount", state.connectedAccountId);
                  uow.create("connectedAccount", {
                    id: state.connectedAccountId,
                    projectId: saved.projectId,
                    providerConfigId: saved.providerConfigId,
                    externalUserId: saved.externalUserId,
                    service: saved.service,
                    connectionName: saved.connectionName,
                  });
                }
              }
              return {
                id: saved.id.toString(),
                projectId: saved.projectId,
                providerConfigId: saved.providerConfigId,
                externalUserId: saved.externalUserId,
                service: saved.service,
                connectionName: saved.connectionName,
                authorizationUrl: saved.authorizationUrl,
                expiresAt: saved.expiresAt,
                state,
              };
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
