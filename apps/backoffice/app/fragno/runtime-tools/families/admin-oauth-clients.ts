import { BACKOFFICE_PERMISSION } from "@/backoffice-runtime/permissions";
import {
  backofficeOAuthClientCreateInputSchema,
  backofficeOAuthClientCreateResultSchema,
  backofficeOAuthClientListInputSchema,
  backofficeOAuthClientPageSchema,
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
      "Create an Auth-owned authorization-code OAuth web or native client for the current System administrator. Confidential clients return an initial secret; public clients use PKCE without a secret. Does not register or install a Backoffice app.",
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

/** System admin OAuth provisioning and catalog reads remain separate from app registration. */
export const adminOAuthClientsRuntimeTools = [createOAuthClientTool, listOAuthClientsTool] as const;
