import { useEffect, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "react-router";

import { CloudflareContext } from "@/cloudflare/cloudflare-context";
import { FormField } from "@/components/backoffice";
import { mcpCapability } from "@/fragno/backoffice-capabilities/capabilities/mcp";

import type { Route } from "./+types/configuration";
import {
  createMcpActionRouteCaller,
  fetchMcpServers,
  type McpServerSummary,
  type McpServerToolsState,
} from "./data";

type McpActionData = {
  ok: boolean;
  intent: string;
  message: string;
  authorizationUrl?: string;
  serverTools?: McpServerToolsState;
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
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const { env } = context.get(CloudflareContext);
  const status = await mcpCapability.connection.getStatus({ env, orgId: params.orgId });
  if (!status.configured) {
    await mcpCapability.connection.configure({
      env,
      orgId: params.orgId,
      origin: new URL(request.url).origin,
      payload: {},
    });
  }

  const { servers, serversError } = await fetchMcpServers(request, context, params.orgId);

  return { servers, serversError } satisfies McpConfigurationLoaderData;
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = getFormString(formData, "intent") || "add-server";
  const origin = new URL(request.url).origin;
  const { env } = context.get(CloudflareContext);

  try {
    const status = await mcpCapability.connection.getStatus({ env, orgId: params.orgId });
    if (!status.configured) {
      await mcpCapability.connection.configure({
        env,
        orgId: params.orgId,
        origin,
        payload: {},
      });
    }

    const callRoute = createMcpActionRouteCaller(request, context, params.orgId);

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

    if (intent === "fetch-tools") {
      const slug = getFormString(formData, "slug");
      const response = await callRoute("GET", "/servers/:slug/tools", {
        pathParams: { slug },
      });
      if (response.type === "json" && response.status >= 200 && response.status < 300) {
        return {
          ok: true,
          intent,
          message: "MCP tools loaded.",
          serverTools: { slug, tools: response.data.tools as McpServerToolsState["tools"] },
        } satisfies McpActionData;
      }
      const message = routeResponseMessage(response) || "Unable to load tools.";
      return {
        ok: false,
        intent,
        message,
        serverTools: { slug, tools: [], error: message },
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
    const slug = intent === "fetch-tools" ? getFormString(formData, "slug") : "";
    return {
      ok: false,
      intent,
      message,
      ...(slug ? { serverTools: { slug, tools: [], error: message } } : {}),
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
          onClick={() => setAuthTab("oauth")}
          className={`min-h-10 border px-3 py-2 text-[10px] font-semibold tracking-[0.22em] uppercase transition-colors active:scale-[0.96] ${tabClass("oauth")}`}
        >
          OAuth
        </button>
        <button
          type="button"
          onClick={() => setAuthTab("bearer")}
          className={`min-h-10 border px-3 py-2 text-[10px] font-semibold tracking-[0.22em] uppercase transition-colors active:scale-[0.96] ${tabClass("bearer")}`}
        >
          Bearer
        </button>
        <button
          type="button"
          onClick={() => setAuthTab("none")}
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

function ServerDetail({
  server,
  toolsState,
  fetchingTools,
}: {
  server: McpServerSummary;
  toolsState: McpServerToolsState | undefined;
  fetchingTools: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            {server.authMode}
          </p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
            {server.name || server.slug}
          </h2>
          <p className="mt-2 text-sm break-all text-[var(--bo-muted)]">{server.endpointUrl}</p>
        </div>
        <Form method="post">
          <input type="hidden" name="intent" value="delete-server" />
          <input type="hidden" name="slug" value={server.slug} />
          <button
            type="submit"
            className="min-h-10 border border-red-500/40 px-3 py-2 text-[10px] tracking-[0.22em] text-red-500 uppercase transition-transform active:scale-[0.96]"
          >
            Delete
          </button>
        </Form>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {server.authMode === "oauth" ? (
          <Form
            method="post"
            className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
          >
            <input type="hidden" name="intent" value="start-oauth" />
            <input type="hidden" name="slug" value={server.slug} />
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Authentication
            </p>
            <input
              name="scope"
              placeholder="scope override (optional)"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-xs text-[var(--bo-fg)]"
            />
            <button
              type="submit"
              className="min-h-10 border border-[color:var(--bo-border)] px-3 py-2 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
            >
              Start OAuth
            </button>
          </Form>
        ) : null}

        {server.authMode === "bearer" ? (
          <Form
            method="post"
            className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
          >
            <input type="hidden" name="intent" value="set-token" />
            <input type="hidden" name="slug" value={server.slug} />
            <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
              Authentication
            </p>
            <input
              type="password"
              name="token"
              placeholder="Bearer token"
              required
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-xs text-[var(--bo-fg)]"
            />
            <button
              type="submit"
              className="min-h-10 border border-[color:var(--bo-border)] px-3 py-2 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] active:scale-[0.96]"
            >
              Save token
            </button>
          </Form>
        ) : null}

        <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
          <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">Tools</p>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            Cached tool discovery is shown automatically when available. Refresh connects to the
            selected server.
          </p>
          {server.cache?.protocolVersion ? (
            <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
              Protocol {server.cache.protocolVersion}
              {server.cache.updatedAt
                ? ` · cached ${new Date(server.cache.updatedAt).toLocaleString()}`
                : ""}
            </p>
          ) : null}
          <Form method="post" className="mt-3">
            <input type="hidden" name="intent" value="fetch-tools" />
            <input type="hidden" name="slug" value={server.slug} />
            <button
              type="submit"
              disabled={fetchingTools}
              className="min-h-10 border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-transform active:scale-[0.96] disabled:opacity-60"
            >
              {fetchingTools ? "Fetching…" : toolsState ? "Refresh tools" : "Fetch tools"}
            </button>
          </Form>
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto pr-1">
        {toolsState?.error ? (
          <div className="border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-500">
            Tools unavailable: {toolsState.error}
          </div>
        ) : null}
        {toolsState && toolsState.tools.length > 0 ? (
          <div className="grid gap-2 xl:grid-cols-2">
            {toolsState.tools.map((tool) => (
              <div
                key={tool.name}
                className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3"
              >
                <p className="font-semibold text-[var(--bo-fg)]">{tool.title || tool.name}</p>
                {tool.description ? (
                  <p className="mt-1 text-xs text-[var(--bo-muted)]">{tool.description}</p>
                ) : null}
                {tool.inputSchema ? (
                  <pre className="mt-2 max-h-56 overflow-auto text-[10px] whitespace-pre-wrap text-[var(--bo-muted-2)]">
                    {JSON.stringify(tool.inputSchema, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        ) : toolsState && !toolsState.error ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
            No tools advertised.
          </div>
        ) : !toolsState ? (
          <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
            Select fetch tools to inspect this server's advertised capabilities.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function BackofficeOrganisationMcpConfiguration() {
  const { servers, serversError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const [authTab, setAuthTab] = useState<AuthTab>("oauth");
  const [toolsByServer, setToolsByServer] = useState(() => new Map<string, McpServerToolsState>());

  const saving = navigation.state === "submitting";
  const submittingIntent = navigation.formData?.get("intent");
  const submittingSlug = navigation.formData?.get("slug");
  const selectedSlug = searchParams.get("server");
  const isConfiguring = searchParams.get("configure") === "1";
  const selectedServer = selectedSlug
    ? (servers.find((server) => server.slug === selectedSlug) ?? null)
    : null;
  const saveError = actionData && !actionData.ok ? actionData.message : null;
  const saveSuccess = actionData?.ok ? actionData.message : null;

  useEffect(() => {
    const serverTools = actionData?.serverTools;
    if (!serverTools) {
      return;
    }
    setToolsByServer((previous) => {
      const next = new Map(previous);
      next.set(serverTools.slug, serverTools);
      return next;
    });
  }, [actionData]);

  useEffect(() => {
    const slugs = new Set(servers.map((server) => server.slug));
    setToolsByServer((previous) => {
      if ([...previous.keys()].every((slug) => slugs.has(slug))) {
        return previous;
      }
      return new Map([...previous].filter(([slug]) => slugs.has(slug)));
    });
  }, [servers]);

  const selectedToolsState = selectedServer
    ? (toolsByServer.get(selectedServer.slug) ??
      (Array.isArray(selectedServer.cache?.tools)
        ? { slug: selectedServer.slug, tools: selectedServer.cache.tools }
        : undefined))
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
            fetchingTools={
              submittingIntent === "fetch-tools" && submittingSlug === selectedServer.slug
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
