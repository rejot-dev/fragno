import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import {
  backofficeOAuthClientCreateInputSchema,
  backofficeOAuthClientCreateResultSchema,
  backofficeOAuthClientListInputSchema,
  backofficeOAuthClientPageSchema,
  backofficeOAuthClientRotateSecretInputSchema,
  backofficeOAuthClientRotateSecretResultSchema,
  backofficeOAuthClientUpdateInputSchema,
  backofficeOAuthClientUpdateResultSchema,
} from "@/fragno/auth/oauth-client";
import { defineCliArgsParser } from "@/fragno/runtime-tools/bash-cli";

import { defineBackofficeRuntimeTool, type BackofficeToolContext } from "../runtime-tools";
import type { AdminRuntime } from "./admin";

type AdminOAuthClientToolContext = BackofficeToolContext<Partial<{ admin: AdminRuntime }>>;

function requireAdminOAuthClientContext(context: AdminOAuthClientToolContext) {
  if (context.execution.scope.kind !== "system") {
    throw new Error("Admin OAuth client management requires System context.");
  }
  const principal = context.execution.actors.principal;
  if (principal?.scope !== "internal" || principal.type !== "user") {
    throw new Error("Admin OAuth client management requires an administrator user principal.");
  }
  const admin = context.runtimes.admin;
  if (!admin) {
    throw new Error("Admin OAuth client runtime is not available in this execution context.");
  }
  return { admin, administratorUserId: principal.id };
}

const createOAuthClientTool = defineBackofficeRuntimeTool(
  {
    id: "admin.oauth-clients.create",
    namespace: "admin",
    name: "oauthClientsCreate",
    description:
      "Create an Auth-owned authorization-code OAuth web or native client for the current System administrator. Confidential clients return an initial secret and may use client credentials; public clients use PKCE without a secret. Does not register or install a Backoffice app.",
    requiredPermissions: [BACKOFFICE_PERMISSION.admin.oauthClientsManage.permission],
    inputSchema: backofficeOAuthClientCreateInputSchema,
    outputSchema: backofficeOAuthClientCreateResultSchema,
    execute: async function createAdministratorOAuthClient(
      input,
      context: AdminOAuthClientToolContext,
    ) {
      const { admin, administratorUserId } = requireAdminOAuthClientContext(context);
      return await admin.createOAuthClient(input, administratorUserId);
    },
    adapters: {
      bash: {
        command: "admin.oauth-clients.create",
        help: {
          summary:
            "admin.oauth-clients.create creates an OAuth web or native client owned by the current System administrator. Store confidential client secrets securely; creation is not idempotent.",
          options: [
            { name: "name", valueRequired: true, valueName: "name", description: "Client name" },
            {
              name: "redirect-uri",
              valueRequired: true,
              valueName: "url",
              description: "Allowed redirect URI; repeat for multiple callbacks",
            },
            {
              name: "scope",
              valueRequired: true,
              valueName: "scope",
              description: "OAuth scope; repeat for multiple scopes (not installation grants)",
            },
            {
              name: "client-type",
              valueRequired: true,
              valueName: "type",
              description: "confidential (default) or public; both require PKCE",
            },
            {
              name: "application-type",
              valueRequired: true,
              valueName: "type",
              description: "web (default) or native; native permits HTTP loopback callbacks",
            },
            {
              name: "client-credentials",
              description:
                "Allow client credentials (confidential clients with the backoffice scope), so an installed app can act as its installation",
            },
          ],
          examples: [
            'admin.oauth-clients.create --name "Accounting" --redirect-uri https://accounting.example/callback --scope openid',
            'admin.oauth-clients.create --name "Accounting" --redirect-uri https://accounting.example/callback --scope openid --scope profile --scope email --format json',
            'admin.oauth-clients.create --name "Accounting SPA" --redirect-uri https://accounting.example/callback --scope openid --client-type public --format json',
            'admin.oauth-clients.create --name "Local OAuth PKCE Test" --application-type native --client-type public --redirect-uri http://127.0.0.1:8789/callback --scope openid --scope profile --scope email',
          ],
        },
        parse: defineCliArgsParser("admin.oauth-clients.create", {
          name: { kind: "string", required: true },
          redirectUris: { kind: "stringArray", option: "redirect-uri", required: true },
          scopes: { kind: "stringArray", option: "scope", required: true },
          clientType: { kind: "string" },
          applicationType: { kind: "string" },
          clientCredentials: { kind: "boolean", option: "client-credentials" },
        }),
        format: (result, options) =>
          options.format === "json" || options.print
            ? { data: result }
            : {
                data: result,
                stdout: [
                  `Created ${result.clientType} OAuth client.`,
                  `Client ID: ${result.clientId}`,
                  result.clientType === "confidential"
                    ? `Client secret: ${result.clientSecret}\nStore this secret securely; it is only returned at creation.`
                    : "Client secret: none (public client)",
                  "",
                ].join("\n"),
              },
      },
    },
  },
  "redacted",
);

const listOAuthClientsTool = defineBackofficeRuntimeTool({
  id: "admin.oauth-clients.list",
  namespace: "admin",
  name: "oauthClientsList",
  description:
    "List the global Auth-owned OAuth client catalog, including other owners and the internal Codemode client, using cursor pagination. Never exposes credentials or credential hashes.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.oauthClientsRead.permission],
  inputSchema: backofficeOAuthClientListInputSchema,
  outputSchema: backofficeOAuthClientPageSchema,
  execute: async function listAdministratorOAuthClients(
    input,
    context: AdminOAuthClientToolContext,
  ) {
    const { admin, administratorUserId } = requireAdminOAuthClientContext(context);
    return await admin.listOAuthClients(input, administratorUserId);
  },
  adapters: {
    bash: {
      command: "admin.oauth-clients.list",
      help: {
        summary:
          "admin.oauth-clients.list lists the global OAuth client catalog without credentials (System administrators only).",
        options: [
          {
            name: "page-size",
            valueRequired: true,
            valueName: "count",
            description: "Page size, 1–100 (default 25)",
          },
          {
            name: "cursor",
            valueRequired: true,
            valueName: "cursor",
            description: "Cursor from the previous page; keep the same page size",
          },
        ],
        examples: [
          "admin.oauth-clients.list",
          "admin.oauth-clients.list --format json",
          "admin.oauth-clients.list --page-size 10 --cursor CURSOR --format json",
        ],
      },
      parse: defineCliArgsParser("admin.oauth-clients.list", {
        pageSize: { kind: "positiveInteger" },
        cursor: { kind: "string" },
      }),
      format: (result, options) => {
        if (options.format === "json" || options.print) {
          return { data: result };
        }
        const entries = result.clients.map((client) =>
          [
            `Client ID: ${client.clientId}`,
            `  Name: ${client.name ?? "(unnamed)"}`,
            `  Redirect URIs: ${client.redirectUris?.join(", ") || "none"}`,
            `  OAuth scopes: ${client.scopes?.join(" ") || "none"}`,
            `  Token endpoint auth method: ${client.tokenEndpointAuthMethod ?? "unspecified"}`,
            `  Owner user ID: ${client.userId ?? "none"}`,
            `  Reference ID: ${client.referenceId ?? "none"}`,
            `  Disabled: ${client.disabled === null ? "unspecified" : client.disabled ? "yes" : "no"}`,
          ].join("\n"),
        );
        return {
          data: result,
          stdout: [
            result.clients.length
              ? `OAuth clients (${result.clients.length}):`
              : "No OAuth clients found.",
            ...entries,
            `More results: ${result.hasNextPage ? "yes" : "no"}`,
            `Next cursor: ${result.nextCursor ?? "none"}`,
            "",
          ].join("\n"),
        };
      },
    },
  },
});

const clientIdOption = {
  name: "client-id",
  required: true,
  valueRequired: true,
  valueName: "id",
  description: "OAuth client ID you own",
};

const updateOAuthClientTool = defineBackofficeRuntimeTool({
  id: "admin.oauth-clients.update",
  namespace: "admin",
  name: "oauthClientsUpdate",
  description:
    "Replace the redirect URIs, OAuth scopes, and client-credentials access of an OAuth client owned by the current System administrator. Widened scopes apply to new authorizations only; existing users authorize again.",
  requiredPermissions: [BACKOFFICE_PERMISSION.admin.oauthClientsManage.permission],
  inputSchema: backofficeOAuthClientUpdateInputSchema,
  outputSchema: backofficeOAuthClientUpdateResultSchema,
  execute: async function updateAdministratorOAuthClient(
    input,
    context: AdminOAuthClientToolContext,
  ) {
    const { admin, administratorUserId } = requireAdminOAuthClientContext(context);
    return await admin.updateOAuthClient(input, administratorUserId);
  },
  adapters: {
    bash: {
      command: "admin.oauth-clients.update",
      help: {
        summary:
          "admin.oauth-clients.update replaces an owned client's redirects, scopes, and client-credentials access. All settings are required so nothing changes implicitly.",
        options: [
          clientIdOption,
          {
            name: "redirect-uri",
            required: true,
            valueRequired: true,
            valueName: "url",
            description: "Allowed redirect URI; repeat for multiple callbacks",
          },
          {
            name: "scope",
            required: true,
            valueRequired: true,
            valueName: "scope",
            description: "OAuth scope; repeat for multiple scopes",
          },
          {
            name: "client-credentials",
            description: "Allow client credentials; omit to remove them",
          },
        ],
        examples: [
          "admin.oauth-clients.update --client-id CLIENT_ID --redirect-uri https://bookkeeping.example/api/auth/callback/backoffice --scope openid --scope profile --scope email --scope offline_access --scope backoffice --client-credentials",
        ],
      },
      parse: defineCliArgsParser("admin.oauth-clients.update", {
        clientId: { kind: "string", required: true },
        redirectUris: { kind: "stringArray", option: "redirect-uri", required: true },
        scopes: { kind: "stringArray", option: "scope", required: true },
        clientCredentials: { kind: "boolean", option: "client-credentials", defaultValue: false },
      }),
      format: (result, options) =>
        options.format === "json" || options.print
          ? { data: result }
          : {
              data: result,
              stdout: [
                "Updated OAuth client.",
                `Client ID: ${result.clientId}`,
                `Redirect URIs: ${result.redirectUris.join(", ")}`,
                `OAuth scopes: ${result.scopes.join(" ")}`,
                `Client credentials: ${result.clientCredentials ? "allowed" : "not allowed"}`,
                "",
              ].join("\n"),
            },
    },
  },
});

const rotateOAuthClientSecretTool = defineBackofficeRuntimeTool(
  {
    id: "admin.oauth-clients.rotate-secret",
    namespace: "admin",
    name: "oauthClientsRotateSecret",
    description:
      "Replace the secret of a confidential OAuth client owned by the current System administrator. The previous secret stops working immediately; the new one is returned once.",
    requiredPermissions: [BACKOFFICE_PERMISSION.admin.oauthClientsManage.permission],
    inputSchema: backofficeOAuthClientRotateSecretInputSchema,
    outputSchema: backofficeOAuthClientRotateSecretResultSchema,
    execute: async function rotateAdministratorOAuthClientSecret(
      input,
      context: AdminOAuthClientToolContext,
    ) {
      const { admin, administratorUserId } = requireAdminOAuthClientContext(context);
      return await admin.rotateOAuthClientSecret(input, administratorUserId);
    },
    adapters: {
      bash: {
        command: "admin.oauth-clients.rotate-secret",
        help: {
          summary:
            "admin.oauth-clients.rotate-secret replaces an owned confidential client's secret. Update the app's configuration before the old secret is needed again.",
          options: [clientIdOption],
          examples: ["admin.oauth-clients.rotate-secret --client-id CLIENT_ID"],
        },
        parse: defineCliArgsParser("admin.oauth-clients.rotate-secret", {
          clientId: { kind: "string", required: true },
        }),
        format: (result, options) =>
          options.format === "json" || options.print
            ? { data: result }
            : {
                data: result,
                stdout: `Rotated OAuth client secret.\nClient ID: ${result.clientId}\nClient secret: ${result.clientSecret}\nStore this secret securely; it is only returned once.\n`,
              },
      },
    },
  },
  "redacted",
);

/** System admin OAuth provisioning and catalog reads remain separate from app registration. */
export const adminOAuthClientsRuntimeTools = [
  createOAuthClientTool,
  listOAuthClientsTool,
  updateOAuthClientTool,
  rotateOAuthClientSecretTool,
] as const;
