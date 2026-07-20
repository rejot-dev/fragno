import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";
import { Streamdown } from "streamdown";

import { FormField } from "@/components/backoffice";
import { requireBackofficeContext } from "@/fragno/auth/backoffice-principal.server";
import { jsonSchemaToTypeScript, type JsonSchemaObject } from "@/lib/zod/zod-formatter";

import {
  createMcpActionRouteCallerForScope,
  ensureMcpConfiguredForScope,
  fetchMcpServersForScope,
  type McpServerRefreshState,
  type McpServerSummary,
  type McpServerToolsState,
} from "../connections/mcp/data";
import type { Route } from "./+types/mcp";
import { automationScopeFromRouteParams } from "./scope";

type McpActionData = {
  ok: boolean;
  intent: string;
  message: string;
  authorizationUrl?: string;
  serverRefresh?: McpServerRefreshState;
};

type McpConfigurationLoaderData = {
  servers: McpServerSummary[];
  serversError: string | null;
};

type AuthTab = "oauth" | "bearer" | "none";

const getFormString = (formData: FormData, key: string) => {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
};

const routeResponseMessage = (response: {
  type: string;
  status: number;
  error?: { message: string };
  data?: unknown;
}) => {
  if (response.type === "json") {
    return JSON.stringify(response.data);
  }
  if (response.type === "error") {
    return response.error?.message ?? `Request failed with status ${response.status}.`;
  }
  return `Request failed with status ${response.status}.`;
};

const parseScopes = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

const selectedServerPath = (slug: string) => `?server=${encodeURIComponent(slug)}`;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);
  await ensureMcpConfiguredForScope(context, scope);

  const { servers, serversError } = await fetchMcpServersForScope(request, context, scope);

  return { servers, serversError } satisfies McpConfigurationLoaderData;
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const scope = automationScopeFromRouteParams(params);
  await requireBackofficeContext(request, context, scope);

  const formData = await request.formData();
  const intent = getFormString(formData, "intent") || "add-server";

  try {
    await ensureMcpConfiguredForScope(context, scope);

    const callRoute = createMcpActionRouteCallerForScope(request, context, scope);

    if (intent === "add-server") {
      const slug = getFormString(formData, "slug");
      const endpointUrl = getFormString(formData, "endpointUrl");
      const name = getFormString(formData, "name");
      const authMode = getFormString(formData, "authMode") || "oauth";
      const token = getFormString(formData, "token");
      const clientId = getFormString(formData, "clientId");
      const clientSecret = getFormString(formData, "clientSecret");
      const scopes = parseScopes(getFormString(formData, "scopes"));

      const auth =
        authMode === "bearer"
          ? { type: "bearer" as const, token }
          : authMode === "none"
            ? { type: "none" as const }
            : {
                type: "oauth" as const,
                ...(clientId ? { clientId } : {}),
                ...(clientSecret ? { clientSecret } : {}),
                ...(scopes.length ? { scopes } : {}),
              };

      const response = await callRoute("POST", "/servers", {
        body: { slug, endpointUrl, ...(name ? { name } : {}), auth },
      });
      if (response.type === "json" && response.status >= 200 && response.status < 300) {
        return { ok: true, intent, message: "MCP server configured." } satisfies McpActionData;
      }
      return {
        ok: false,
        intent,
        message: routeResponseMessage(response),
      } satisfies McpActionData;
    }

    if (intent === "start-oauth") {
      const slug = getFormString(formData, "slug");
      const scope = getFormString(formData, "scope");
      const clientId = getFormString(formData, "clientId");
      const clientSecret = getFormString(formData, "clientSecret");
      const response = await callRoute("POST", "/servers/:slug/auth/start", {
        pathParams: { slug },
        body: {
          ...(scope ? { scope } : {}),
          ...(clientId ? { clientId } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        },
      });
      if (response.type === "json" && response.status >= 200 && response.status < 300) {
        return {
          ok: true,
          intent,
          message: "OAuth authorization URL created.",
          authorizationUrl: response.data.authorizationUrl,
        } satisfies McpActionData;
      }
      return {
        ok: false,
        intent,
        message: routeResponseMessage(response),
      } satisfies McpActionData;
    }

    if (intent === "set-token") {
      const slug = getFormString(formData, "slug");
      const token = getFormString(formData, "token");
      if (!token) {
        return { ok: false, intent, message: "Bearer token is required." } satisfies McpActionData;
      }
      const response = await callRoute("POST", "/servers/:slug/auth/token", {
        pathParams: { slug },
        body: { token },
      });
      if (response.type === "json" && response.status >= 200 && response.status < 300) {
        return { ok: true, intent, message: "Bearer token saved." } satisfies McpActionData;
      }
      return {
        ok: false,
        intent,
        message: routeResponseMessage(response),
      } satisfies McpActionData;
    }

    if (intent === "refresh-server") {
      const slug = getFormString(formData, "slug");
      const response = await callRoute("POST", "/servers/:slug/refresh", {
        pathParams: { slug },
      });
      if (response.type === "json" && response.status >= 200 && response.status < 300) {
        const refresh = response.data as McpServerRefreshState["refresh"];
        return {
          ok: refresh.ok,
          intent,
          message: refresh.ok
            ? "Connection check passed and tool cache refreshed."
            : refresh.error?.message || "Connection check failed.",
          serverRefresh: { slug, refresh },
        } satisfies McpActionData;
      }
      return {
        ok: false,
        intent,
        message: routeResponseMessage(response) || "Unable to check server.",
      } satisfies McpActionData;
    }

    if (intent === "delete-server") {
      const slug = getFormString(formData, "slug");
      const response = await callRoute("DELETE", "/servers/:slug", { pathParams: { slug } });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, intent, message: "MCP server deleted." } satisfies McpActionData;
      }
      return {
        ok: false,
        intent,
        message: routeResponseMessage(response),
      } satisfies McpActionData;
    }

    return { ok: false, intent, message: "Unknown MCP action." } satisfies McpActionData;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update MCP server.";
    return {
      ok: false,
      intent,
      message,
    } satisfies McpActionData;
  }
}

function ServerConfigureForm({
  authTab,
  setAuthTab,
  saving,
}: {
  authTab: AuthTab;
  setAuthTab: (tab: AuthTab) => void;
  saving: boolean;
}) {
  const tabClass = (tab: AuthTab) =>
    authTab === tab
      ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
      : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            Configure
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Configure server</h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--bo-muted)]">
            Register a remote streamable HTTP MCP endpoint and choose the authentication method it
            requires.
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-1">
        <button
          type="button"
          onClick={() => {
            setAuthTab("oauth");
          }}
          className={`min-h-10 border px-3 py-2 text-[10px] font-semibold tracking-[0.22em] uppercase transition-colors active:scale-[0.96] ${tabClass("oauth")}`}
        >
          OAuth
        </button>
        <button
          type="button"
          onClick={() => {
            setAuthTab("bearer");
          }}
          className={`min-h-10 border px-3 py-2 text-[10px] font-semibold tracking-[0.22em] uppercase transition-colors active:scale-[0.96] ${tabClass("bearer")}`}
        >
          Bearer
        </button>
        <button
          type="button"
          onClick={() => {
            setAuthTab("none");
          }}
          className={`min-h-10 border px-3 py-2 text-[10px] font-semibold tracking-[0.22em] uppercase transition-colors active:scale-[0.96] ${tabClass("none")}`}
        >
          No auth
        </button>
      </div>

      <Form method="post" className="mt-4 min-h-0 flex-1 overflow-auto pr-1">
        <input type="hidden" name="intent" value="add-server" />
        <input type="hidden" name="authMode" value={authTab} />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Slug" hint="Lowercase letters, numbers, and dashes.">
            <input
              name="slug"
              placeholder="docs"
              required
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            />
          </FormField>
          <FormField label="Display name" hint="Optional.">
            <input
              name="name"
              placeholder="Docs MCP"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            />
          </FormField>
          <FormField label="Endpoint URL" hint="Streamable HTTP MCP endpoint.">
            <input
              type="url"
              name="endpointUrl"
              placeholder="https://example.com/mcp"
              required
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            />
          </FormField>
          {authTab === "oauth" ? (
            <>
              <FormField label="OAuth scopes" hint="Space or comma separated.">
                <input
                  name="scopes"
                  placeholder="tools read"
                  className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
                />
              </FormField>
              <FormField label="Client ID" hint="Optional for providers with dynamic clients.">
                <input
                  name="clientId"
                  className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
                />
              </FormField>
              <FormField label="Client secret" hint="Optional for OAuth servers that require it.">
                <input
                  type="password"
                  name="clientSecret"
                  className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
                />
              </FormField>
            </>
          ) : authTab === "bearer" ? (
            <FormField label="Bearer token" hint="Stored for requests to this MCP server.">
              <input
                type="password"
                name="token"
                placeholder="mcp_..."
                required
                className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)]"
              />
            </FormField>
          ) : (
            <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)] md:col-span-2">
              This server will be called without authentication headers.
            </div>
          )}
        </div>
        <button
          type="submit"
          disabled={saving}
          className="mt-4 w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] active:scale-[0.96] disabled:opacity-60"
        >
          {saving
            ? "Configuring…"
            : `Configure ${authTab === "oauth" ? "OAuth" : authTab === "bearer" ? "bearer" : "no auth"} server`}
        </button>
      </Form>
    </div>
  );
}

const formatMaybeDate = (value?: string | Date | null) =>
  value ? new Date(value).toLocaleString() : "-";

const normalizeToolTypeName = (name: string) => {
  const pascal = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
  const safe = pascal || "Tool";
  return /^\d/.test(safe) ? `Tool${safe}` : safe;
};

const toolInputTypeScript = (tool: McpServerToolsState["tools"][number]) => {
  const typeName = `${normalizeToolTypeName(tool.name)}Input`;
  const schema = tool.inputSchema as JsonSchemaObject | undefined;
  return `type ${typeName} = ${jsonSchemaToTypeScript(schema)};`;
};

const toolInputJson = (tool: McpServerToolsState["tools"][number]) =>
  JSON.stringify(tool.inputSchema ?? {}, null, 2);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isScopeToken = (scope: string) => /^[a-z][a-z0-9:_./-]{1,}$/i.test(scope);

const splitScopes = (value: string) =>
  value
    .replace(/[`*_]/g, "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim().replace(/^[[({]+|[\])}.;:]+$/g, ""))
    .filter(isScopeToken);

const listStrings = (value: unknown) => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? splitScopes(item) : []));
  }
  if (typeof value === "string" && value.trim()) {
    return splitScopes(value);
  }
  return [];
};

const requiredScopesLinePattern =
  /^\s*(?:[-*]\s*)?(?:#{1,6}\s*)?(?:\*\*)?(?:required\s+|requires\s+)?(?:oauth\s+)?scopes?(?:\*\*)?\s*:?\s*(.*?)\s*$/i;
const trailingInlineScopePattern = /(?:\s+|^)`([^`]+)`\s*$/;
const bulletScopePattern = /^\s*[-*]\s+(.+?)\s*$/;

const descriptionWithoutRequiredScopes = (description: string | undefined) => {
  const scopes: string[] = [];
  const visibleLines: string[] = [];
  let inRequiredScopesList = false;

  for (const line of description?.split("\n") ?? []) {
    const requiredScopesLine = requiredScopesLinePattern.exec(line);
    if (requiredScopesLine) {
      scopes.push(...splitScopes(requiredScopesLine[1] ?? ""));
      inRequiredScopesList = true;
      continue;
    }

    if (inRequiredScopesList) {
      if (!line.trim()) {
        inRequiredScopesList = false;
        visibleLines.push(line);
        continue;
      }

      const bulletScope = bulletScopePattern.exec(line);
      if (bulletScope) {
        scopes.push(...splitScopes(bulletScope[1] ?? ""));
        continue;
      }

      inRequiredScopesList = false;
    }

    let visibleLine = line;
    const trailingInlineScope = trailingInlineScopePattern.exec(visibleLine);
    if (trailingInlineScope && /[.!?]\s*$/.test(visibleLine.slice(0, trailingInlineScope.index))) {
      const trailingScopes = splitScopes(trailingInlineScope[1] ?? "");
      if (trailingScopes.length > 0) {
        scopes.push(...trailingScopes);
        visibleLine = visibleLine.slice(0, trailingInlineScope.index).trimEnd();
      }
    }

    if (visibleLine.trim()) {
      visibleLines.push(visibleLine.trimEnd());
    }
  }

  return {
    description: visibleLines.join("\n").trim(),
    scopes,
  };
};

const toolScopes = (tool: McpServerToolsState["tools"][number]) => {
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  const meta = isRecord(tool._meta) ? tool._meta : {};
  const scopes = [
    ...listStrings(annotations.requiredScopes),
    ...listStrings(annotations.required_scopes),
    ...listStrings(meta.requiredScopes),
    ...listStrings(meta.required_scopes),
    ...descriptionWithoutRequiredScopes(tool.description).scopes,
  ];
  return [...new Set(scopes)];
};

const toolDescription = (description: string | undefined) =>
  descriptionWithoutRequiredScopes(description).description;

function ServerStatusPanel({
  server,
  refreshState,
  checkingServer,
}: {
  server: McpServerSummary;
  refreshState: McpServerRefreshState | undefined;
  checkingServer: boolean;
}) {
  const refresh = refreshState?.refresh;
  const cacheToolCount = Array.isArray(server.cache?.tools) ? server.cache.tools.length : 0;
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Connection
          </p>
          <h2 className="mt-2 text-2xl leading-tight font-semibold text-balance text-[var(--bo-fg)]">
            {server.name || server.slug}
          </h2>
          <p className="mt-2 max-w-4xl text-sm break-all text-[var(--bo-muted)]">
            {server.endpointUrl}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="refresh-server" />
            <input type="hidden" name="slug" value={server.slug} />
            <button
              type="submit"
              disabled={checkingServer}
              className="min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96] disabled:opacity-60"
            >
              {checkingServer ? "Refreshing…" : "Refresh"}
            </button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="delete-server" />
            <input type="hidden" name="slug" value={server.slug} />
            <button
              type="submit"
              className="min-h-10 border border-red-500/40 px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-red-500 uppercase transition-transform active:scale-[0.96]"
            >
              Delete
            </button>
          </Form>
        </div>
      </div>

      <div className="mt-4 grid gap-3 text-xs text-[var(--bo-muted)] md:grid-cols-4">
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <p className="text-[9px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">Auth</p>
          <p className="mt-2 font-medium text-[var(--bo-fg)]">
            {refresh?.auth.authenticated ? "Authenticated" : refresh ? "Needs attention" : "-"}
          </p>
          <p className="mt-1">Expires {formatMaybeDate(refresh?.auth.expiresAt)}</p>
        </div>
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <p className="text-[9px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">Cached</p>
          <p className="mt-2 font-medium text-[var(--bo-fg)] tabular-nums">
            {cacheToolCount} tools
          </p>
          {server.cache?.updatedAt ? (
            <p className="mt-1">{new Date(server.cache.updatedAt).toLocaleString()}</p>
          ) : null}
        </div>
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <p className="text-[9px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">Live</p>
          <p className="mt-2 font-medium text-[var(--bo-fg)] tabular-nums">
            {refresh?.live.listToolsOk
              ? `${refresh.live.toolCount ?? 0} tools`
              : refresh
                ? "Discovery failed"
                : "-"}
          </p>
          <p className="mt-1">
            Protocol {refresh?.live.protocolVersion ?? server.cache?.protocolVersion ?? "-"}
          </p>
        </div>
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
          <p className="text-[9px] tracking-[0.2em] text-[var(--bo-muted-2)] uppercase">Checked</p>
          <p className="mt-2 font-medium text-[var(--bo-fg)]">
            {formatMaybeDate(refresh?.checkedAt)}
          </p>
        </div>

        {refresh?.error ? (
          <div className="border border-red-500/40 bg-red-500/5 p-3 text-red-500 md:col-span-4">
            {refresh.error.code}: {refresh.error.message}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolDescription({ description }: { description: string }) {
  return (
    <Streamdown
      mode="static"
      className="bo-session-markdown text-sm leading-6 text-pretty"
      controls={{ code: true, table: true }}
      skipHtml
    >
      {description}
    </Streamdown>
  );
}

type ToolRepresentationMode = "ts" | "json";

function ToolsList({ tools }: { tools: McpServerToolsState["tools"] }) {
  const [query, setQuery] = useState("");
  const [representationMode, setRepresentationMode] = useState<ToolRepresentationMode>("ts");
  const filteredTools = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return tools;
    }
    return tools.filter((tool) => tool.name.toLowerCase().includes(normalizedQuery));
  }, [query, tools]);

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 bg-[var(--bo-panel)] pb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label className="block text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Search Tools
            </label>
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search by tool name…"
              className="mt-2 min-h-11 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
            />
          </div>
          <div>
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Mode</p>
            <div className="mt-2 flex min-h-11 border border-[color:var(--bo-border)]">
              {(
                [
                  ["ts", "TS"],
                  ["json", "JSON"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={representationMode === mode}
                  onClick={() => {
                    setRepresentationMode(mode);
                  }}
                  className={`border-r border-[color:var(--bo-border)] px-3 py-2 text-[10px] font-semibold tracking-[0.18em] uppercase last:border-r-0 ${
                    representationMode === mode
                      ? "bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                      : "bg-[var(--bo-panel-2)] text-[var(--bo-muted-2)] hover:text-[var(--bo-fg)]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {filteredTools.length ? (
        <ol className="space-y-3">
          {filteredTools.map((tool) => {
            const scopes = toolScopes(tool);
            const description = toolDescription(tool.description);
            return (
              <li key={tool.name} className="border border-[color:var(--bo-border)] p-4">
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-lg leading-tight font-semibold text-balance text-[var(--bo-fg)]">
                      {tool.title || tool.name}
                    </h3>
                    <p className="mt-1 font-mono text-xs break-all text-[var(--bo-muted-2)]">
                      {tool.name}
                    </p>
                  </div>
                  {scopes.length ? (
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {scopes.map((scope) => (
                        <span
                          key={scope}
                          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.12em] text-[var(--bo-muted-2)] uppercase"
                        >
                          {scope}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="mt-4">
                  {description ? (
                    <ToolDescription description={description} />
                  ) : (
                    <p className="text-sm text-[var(--bo-muted-2)]">No description provided.</p>
                  )}
                </div>

                <div className="mt-4 border-t border-[color:var(--bo-border)] pt-4">
                  <p className="mb-2 text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                    {representationMode === "ts" ? "Input type" : "Input schema"}
                  </p>
                  <pre className="max-h-96 overflow-auto bg-[var(--bo-panel-2)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-[var(--bo-fg)]">
                    <code>
                      {representationMode === "ts"
                        ? toolInputTypeScript(tool)
                        : toolInputJson(tool)}
                    </code>
                  </pre>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-8 text-center text-sm text-[var(--bo-muted)]">
          No tool names match “{query.trim()}”.
        </div>
      )}
    </div>
  );
}

function ServerDetail({
  server,
  toolsState,
  refreshState,
  checkingServer,
}: {
  server: McpServerSummary;
  toolsState: McpServerToolsState | undefined;
  refreshState: McpServerRefreshState | undefined;
  checkingServer: boolean;
}) {
  const refresh = refreshState?.refresh;
  const authNeedsAttention = refresh
    ? !refresh.auth.authenticated ||
      refresh.auth.expired === true ||
      Boolean(refresh.auth.scopes.missing?.length) ||
      Boolean(refresh.error)
    : false;
  const showOAuthControls = server.authMode === "oauth";
  const showBearerControls = server.authMode === "bearer";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="space-y-4">
        <ServerStatusPanel
          server={server}
          refreshState={refreshState}
          checkingServer={checkingServer}
        />

        <div className="grid gap-4 xl:grid-cols-2">
          {showOAuthControls ? (
            <Form
              method="post"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
            >
              <input type="hidden" name="intent" value="start-oauth" />
              <input type="hidden" name="slug" value={server.slug} />
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                {authNeedsAttention ? "Authentication required" : "OAuth authentication"}
              </p>
              <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">
                {authNeedsAttention
                  ? "OAuth needs attention for this server. Start the provider flow, then this page will refresh the tool cache automatically when you return."
                  : "Re-run OAuth to replace or expand the current provider authorization."}
              </p>
              <input
                name="scope"
                placeholder="scope override (optional)"
                className="mt-3 min-h-10 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-xs text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
              />
              <button
                type="submit"
                className="mt-3 min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96]"
              >
                {authNeedsAttention ? "Start OAuth" : "Reauthorize OAuth"}
              </button>
            </Form>
          ) : null}

          {showBearerControls ? (
            <Form
              method="post"
              className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4"
            >
              <input type="hidden" name="intent" value="set-token" />
              <input type="hidden" name="slug" value={server.slug} />
              <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                {authNeedsAttention ? "Token required" : "Bearer token"}
              </p>
              <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">
                {authNeedsAttention
                  ? "Save a bearer token before Backoffice can discover tools for this server."
                  : "Save a replacement bearer token if the current token is revoked, expired, or missing scopes."}
              </p>
              <input
                type="password"
                name="token"
                placeholder="Bearer token"
                required
                className="mt-3 min-h-10 w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-xs text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] focus:border-[color:var(--bo-accent)]"
              />
              <button
                type="submit"
                className="mt-3 min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96]"
              >
                {authNeedsAttention ? "Save token" : "Update token"}
              </button>
            </Form>
          ) : null}
        </div>
      </div>

      <div className="relative mt-5 min-h-0 flex-1 overflow-auto pr-1">
        {toolsState?.error ? (
          <div className="mb-4 border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-500">
            Tools unavailable: {toolsState.error}
          </div>
        ) : null}
        {toolsState && toolsState.tools.length > 0 ? (
          <ToolsList key={server.slug} tools={toolsState.tools} />
        ) : toolsState && !toolsState.error ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-8 text-center text-sm text-[var(--bo-muted)]">
            No tools advertised.
          </div>
        ) : !toolsState ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-8 text-center text-sm text-[var(--bo-muted)]">
            Cached tools will appear here immediately; the live refresh starts when you select the
            server.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function BackofficeOrganisationMcpConfiguration() {
  const { servers, serversError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const refreshFetcher = useFetcher<typeof action>();
  const lastAutoRefreshSlug = useRef<string | null>(null);
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [authTab, setAuthTab] = useState<AuthTab>("oauth");
  const [refreshByServer, setRefreshByServer] = useState(
    () => new Map<string, McpServerRefreshState>(),
  );

  const saving = navigation.state === "submitting";
  const submittingIntent = navigation.formData?.get("intent");
  const submittingSlug = navigation.formData?.get("slug");
  const selectedSlug = searchParams.get("server");
  const oauthStatus = searchParams.get("oauth");
  const isConfiguring = searchParams.get("configure") === "1";
  const selectedServer = selectedSlug
    ? (servers.find((server) => server.slug === selectedSlug) ?? null)
    : null;
  const saveError = actionData && !actionData.ok ? actionData.message : null;
  const saveSuccess = actionData?.ok ? actionData.message : null;

  useEffect(() => {
    const serverRefresh = actionData?.serverRefresh;
    if (!serverRefresh) {
      return;
    }
    setRefreshByServer((previous) => {
      const next = new Map(previous);
      next.set(serverRefresh.slug, serverRefresh);
      return next;
    });
  }, [actionData]);

  useEffect(() => {
    const serverRefresh = refreshFetcher.data?.serverRefresh;
    if (!serverRefresh) {
      return;
    }
    setRefreshByServer((previous) => {
      const next = new Map(previous);
      next.set(serverRefresh.slug, serverRefresh);
      return next;
    });
  }, [refreshFetcher.data]);

  useEffect(() => {
    if (!selectedServer || isConfiguring) {
      lastAutoRefreshSlug.current = null;
      return;
    }
    if (lastAutoRefreshSlug.current === selectedServer.slug) {
      return;
    }
    lastAutoRefreshSlug.current = selectedServer.slug;
    const formData = new FormData();
    formData.set("intent", "refresh-server");
    formData.set("slug", selectedServer.slug);
    void refreshFetcher.submit(formData, { method: "post" });
  }, [isConfiguring, selectedServer?.slug, refreshFetcher]);

  useEffect(() => {
    const slugs = new Set(servers.map((server) => server.slug));
    setRefreshByServer((previous) => {
      if ([...previous.keys()].every((slug) => slugs.has(slug))) {
        return previous;
      }
      return new Map([...previous].filter(([slug]) => slugs.has(slug)));
    });
  }, [servers]);

  const selectedRefreshState = selectedServer
    ? refreshByServer.get(selectedServer.slug)
    : undefined;
  const refreshFetcherSlug = refreshFetcher.formData?.get("slug");
  const refreshFetcherIntent = refreshFetcher.formData?.get("intent");
  const isAutoRefreshingSelected =
    refreshFetcher.state !== "idle" &&
    refreshFetcherIntent === "refresh-server" &&
    refreshFetcherSlug === selectedServer?.slug;
  const cachedTools = Array.isArray(selectedServer?.cache?.tools) ? selectedServer.cache.tools : [];
  const selectedToolsState = selectedServer
    ? selectedRefreshState
      ? {
          slug: selectedServer.slug,
          tools: selectedRefreshState.refresh.tools.length
            ? selectedRefreshState.refresh.tools
            : cachedTools,
          ...(selectedRefreshState.refresh.error
            ? { error: selectedRefreshState.refresh.error.message }
            : {}),
        }
      : cachedTools.length
        ? { slug: selectedServer.slug, tools: cachedTools }
        : undefined
    : undefined;

  const configureLinkClass = isConfiguring
    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]";

  return (
    <section className="grid min-h-[min(760px,calc(100vh-15rem))] grid-rows-1 gap-4 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">MCP</p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Servers</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase tabular-nums">
            {servers.length} total
          </span>
        </div>

        <Link to="?configure=1" preventScrollReset className={configureLinkClass}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--bo-fg)]">Configure server</p>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
              New
            </span>
          </div>
        </Link>

        {serversError ? <p className="text-sm text-red-500">{serversError}</p> : null}

        <div className="min-h-0 flex-1 overflow-auto pr-1">
          <div className="space-y-2">
            {servers.length === 0 ? (
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
                No MCP servers configured yet.
              </div>
            ) : (
              servers.map((server) => {
                const isSelected = !isConfiguring && selectedServer?.slug === server.slug;
                return (
                  <Link
                    key={server.slug}
                    to={selectedServerPath(server.slug)}
                    preventScrollReset
                    aria-current={isSelected ? "page" : undefined}
                    className={
                      isSelected
                        ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                        : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--bo-fg)]">
                          {server.name || server.slug}
                        </p>
                        <p className="mt-1 truncate text-xs text-[var(--bo-muted-2)]">
                          {server.endpointUrl}
                        </p>
                      </div>
                      <span className="shrink-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
                        {server.authMode}
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        {oauthStatus === "error" ? (
          <div className="border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
            MCP OAuth could not be completed.
          </div>
        ) : oauthStatus === "success" ? (
          <div className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-3 text-sm text-[var(--bo-accent-fg)]">
            MCP OAuth authentication complete.
          </div>
        ) : null}
        {saveError ? (
          <div className="border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
            {saveError}
          </div>
        ) : null}
        {saveSuccess ? (
          <div className="border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] p-3 text-sm text-[var(--bo-accent-fg)]">
            {saveSuccess}
            {actionData?.intent === "start-oauth" && actionData.authorizationUrl ? (
              <>
                {" "}
                <a
                  href={actionData.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open authorization page
                </a>
              </>
            ) : null}
          </div>
        ) : null}

        {isConfiguring ? (
          <ServerConfigureForm
            authTab={authTab}
            setAuthTab={setAuthTab}
            saving={saving && submittingIntent === "add-server"}
          />
        ) : selectedServer ? (
          <ServerDetail
            server={selectedServer}
            toolsState={selectedToolsState}
            refreshState={selectedRefreshState}
            checkingServer={
              isAutoRefreshingSelected ||
              (submittingIntent === "refresh-server" && submittingSlug === selectedServer.slug)
            }
          />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-8 text-center">
            <div>
              <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                No server selected
              </p>
              <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                Select a server or configure a new one.
              </h2>
              <p className="mt-2 text-sm text-[var(--bo-muted)]">
                Server details, authentication controls, and cached tools appear here.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
