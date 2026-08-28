import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router";

import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
  resolveBackofficeRouteScope,
} from "@/backoffice-runtime/resolved-scope";
import { requireBackofficeRouteScopeFromParams } from "@/backoffice-runtime/route-scope";
import { isBackofficeScopeCodecError } from "@/backoffice-runtime/scope-codec";
import { BackofficePageHeader } from "@/components/backoffice";
import { findBackofficeMe } from "@/fragno/auth/auth-server";
import type { DurableHookQueueEntry, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

import { buildBackofficeLoginPath } from "../auth-navigation";
import { lookupAutomationProject, toExternalId } from "../automations/data.server";
import type { Route } from "./+types/durable-hooks-scope-layout";
import {
  createDurableHooksObjectOptions,
  defaultDurableHooksObjectForScope,
  durableHooksSelectionPath,
  DURABLE_HOOKS_OBJECT_CONFIGURE_META,
  getDurableHooksLoaderErrorMessage,
  getDurableHooksObjectDefinition,
  resolveDurableHooksScopeSelection,
  type DurableHooksObjectOption,
  type DurableHooksProject,
  type DurableHooksScopeSelection,
} from "./durable-hooks-scope";
import { formatTimestamp, getStatusBadgeClasses } from "./durable-hooks-shared";
import { internalsScopeBasePath } from "./internals-scope";

export type DurableHooksScopeOutletContext = {
  hooks: DurableHookQueueEntry[];
  objectBasePath: string;
};

type DurableHooksScopeLoaderData = DurableHookQueueResponse & {
  error: string | null;
  selection: DurableHooksScopeSelection;
  objectOptions: DurableHooksObjectOption[];
  objectNotFound: boolean;
};

const parsePageSize = (value: string | null) => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const loadDurableHookQueue = async ({
  context,
  selection,
  cursor,
  pageSize,
}: {
  context: Route.LoaderArgs["context"];
  selection: DurableHooksScopeSelection;
  cursor?: string;
  pageSize?: number;
}): Promise<DurableHookQueueResponse> => {
  const objects = getBackofficeObjects(context);
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(selection.resolvedScope);
  const queueOptions = { cursor, pageSize };

  switch (selection.objectId) {
    case "api":
      return await objects.api.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "auth":
      return await objects.auth.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "forms":
      return await objects.forms.singleton().commands.getDurableHookQueue(queueOptions);
    case "automations":
      return await objects.automations
        .for(runtimeScope)
        .commands.getDurableHookQueue("automation", queueOptions);
    case "telegram":
      return await objects.telegram.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "otp":
      return await objects.otp.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "resend":
      return await objects.resend.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "mcp":
      return await objects.mcp.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "upload":
      return await objects.upload.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "github":
      return await objects.github.for(runtimeScope).commands.getDurableHookQueue(queueOptions);
    case "pi":
      return await objects.automations
        .for(runtimeScope)
        .commands.getDurableHookQueue("pi", queueOptions);
    case "workflows":
      return await objects.automations
        .for(runtimeScope)
        .commands.getDurableHookQueue("workflows", queueOptions);
  }

  throw new Error("Unsupported durable hooks object.");
};

function normalizeProject(
  orgId: string,
  project: Awaited<ReturnType<typeof lookupAutomationProject>>,
): DurableHooksProject[] {
  if (project.status !== "found" || project.project.archivedAt) {
    return [];
  }

  const id = toExternalId(project.project.id);
  if (!id) {
    return [];
  }

  return [
    {
      id,
      orgId,
      label: project.project.name?.trim() || project.project.slug?.trim() || id,
      slug: project.project.slug?.trim() || null,
    },
  ];
}

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await findBackofficeMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organizations = me.organizations.map((entry) => entry.organization);
  let routeScope;
  try {
    routeScope = requireBackofficeRouteScopeFromParams(params);
  } catch (error) {
    if (isBackofficeScopeCodecError(error)) {
      throw new Response("Not Found", { status: 404 });
    }
    throw error;
  }
  const resolvedScope = resolveBackofficeRouteScope(routeScope, organizations);
  if (!resolvedScope) {
    throw new Response("Not Found", { status: 404 });
  }
  if (resolvedScope.kind === "user" && resolvedScope.userId !== me.user.id) {
    throw new Response("Not Found", { status: 404 });
  }
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(resolvedScope);
  const projectLookup =
    runtimeScope.kind === "project"
      ? await lookupAutomationProject(context, runtimeScope.orgId, runtimeScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw Response.json(
      {
        code: "DURABLE_HOOK_PROJECT_UNAVAILABLE",
        message: projectLookup.message,
      },
      { status: 502, statusText: "Bad Gateway" },
    );
  }
  const projects =
    runtimeScope.kind === "project" && projectLookup
      ? normalizeProject(runtimeScope.orgId, projectLookup)
      : [];

  const requestedSelection = resolveDurableHooksScopeSelection({
    scope: runtimeScope,
    objectId: params.objectId,
    organizations,
    projects,
    user: me.user,
  });
  const selection =
    requestedSelection ??
    resolveDurableHooksScopeSelection({
      scope: runtimeScope,
      objectId: defaultDurableHooksObjectForScope(runtimeScope),
      organizations,
      projects,
      user: me.user,
    });
  if (!selection) {
    throw new Response("Not Found", { status: 404 });
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;
  const pageSize = parsePageSize(url.searchParams.get("pageSize"));
  const inspectorData = {
    selection,
    objectOptions: createDurableHooksObjectOptions(selection),
    objectNotFound: requestedSelection === null,
  };

  if (!requestedSelection) {
    return {
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
      error: null,
      ...inspectorData,
    } satisfies DurableHooksScopeLoaderData;
  }

  try {
    const queue = await loadDurableHookQueue({ context, selection, cursor, pageSize });
    return {
      ...queue,
      error: null,
      ...inspectorData,
    } satisfies DurableHooksScopeLoaderData;
  } catch (error) {
    return {
      configured: false,
      hooksEnabled: false,
      namespace: null,
      items: [],
      cursor: undefined,
      hasNextPage: false,
      error: getDurableHooksLoaderErrorMessage({ selection, error }),
      ...inspectorData,
    } satisfies DurableHooksScopeLoaderData;
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  const scopeLabel = loaderData?.selection.label ?? "scope";
  const objectLabel = loaderData
    ? (getDurableHooksObjectDefinition(loaderData.selection.objectId)?.label ?? "object")
    : "object";
  return [{ title: `Durable Hooks · ${scopeLabel} · ${objectLabel}` }];
}

function DurableHooksObjectPicker({
  selectedObjectId,
  options,
}: {
  selectedObjectId: DurableHooksScopeSelection["objectId"] | null;
  options: DurableHooksObjectOption[];
}) {
  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-3">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        Durable object
      </p>
      <p className="mt-1 text-sm text-[var(--bo-muted)]">
        Objects are filtered by the scope policy in the Backoffice object registry.
      </p>
      <div
        role="tablist"
        aria-label="Durable hook objects"
        className="mt-3 flex flex-wrap items-center gap-2"
      >
        {options.map((option) => {
          const isActive = option.id === selectedObjectId;
          return (
            <Link
              key={option.id}
              to={option.to}
              role="tab"
              aria-label={`${option.label} · ${option.binding}`}
              aria-selected={isActive}
              className={
                isActive
                  ? "border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                  : "border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
              }
            >
              {option.label}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

export default function BackofficeDurableHooksScopeLayout({ loaderData }: Route.ComponentProps) {
  const {
    items,
    configured,
    hooksEnabled,
    namespace,
    error,
    cursor,
    hasNextPage,
    selection,
    objectOptions,
    objectNotFound,
  } = loaderData;
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const selectedHookId = params.hookId ?? null;
  const objectBasePath = durableHooksSelectionPath(selection);
  const searchParams = new URLSearchParams(location.search);
  const currentCursor = searchParams.get("cursor");
  const isDetailRoute = Boolean(selectedHookId);
  const listVisibility = isDetailRoute ? "hidden lg:block" : "block";
  const detailVisibility = isDetailRoute ? "block" : "hidden lg:block";
  const objectLabel =
    getDurableHooksObjectDefinition(selection.objectId)?.label ?? selection.objectId;
  const configureMeta = DURABLE_HOOKS_OBJECT_CONFIGURE_META[selection.objectId] ?? null;
  const selectionRouteScope = backofficeRouteScopeFromResolvedScope(selection.resolvedScope);
  const configureOrgSlug =
    selectionRouteScope.kind === "org" || selectionRouteScope.kind === "project"
      ? selectionRouteScope.orgSlug
      : null;
  const configurePath =
    configureOrgSlug && configureMeta ? configureMeta.path(configureOrgSlug) : null;
  const queueCount = items.length;

  const nextSearchParams = new URLSearchParams(searchParams);
  if (cursor) {
    nextSearchParams.set("cursor", cursor);
  }
  const nextSearch = nextSearchParams.toString();
  const nextPageHref = cursor ? `${objectBasePath}?${nextSearch}` : null;
  const newestSearchParams = new URLSearchParams(searchParams);
  newestSearchParams.delete("cursor");
  const newestSearch = newestSearchParams.toString();
  const newestPageHref = newestSearch ? `${objectBasePath}?${newestSearch}` : objectBasePath;
  const internalsBasePath = internalsScopeBasePath(
    backofficeRouteScopeFromResolvedScope(selection.resolvedScope),
  );

  useEffect(() => {
    if (!selectedHookId || items.some((item) => item.id === selectedHookId)) {
      return;
    }

    void navigate(`${objectBasePath}${location.search}`, { replace: true });
  }, [items, selectedHookId, objectBasePath, location.search, navigate]);

  return (
    <div className="min-w-0 space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: internalsBasePath },
          { label: "Durable hooks", to: `${internalsBasePath}/durable-hooks` },
          { label: selection.label },
        ]}
        eyebrow="Internals"
        title={`Durable hook queue · ${selection.label}`}
        description={`Review queued hooks and retry state for durable objects in this ${selection.kind} scope.`}
      />

      <DurableHooksObjectPicker
        selectedObjectId={objectNotFound ? null : selection.objectId}
        options={objectOptions}
      />

      {objectNotFound ? (
        <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-6">
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">404</p>
          <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
            Durable object not found
          </h2>
          <p className="mt-2 text-sm text-[var(--bo-muted)]">
            This fragment or Durable Object is not available in the selected scope.
          </p>
        </section>
      ) : (
        <section className="grid min-w-0 gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div
            className={`${listVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
                  Queue
                </p>
                <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                  {objectLabel} durable hooks
                </h2>
                <p className="mt-1 text-xs text-[var(--bo-muted-2)]">
                  Namespace: {namespace ?? "Unavailable"}
                </p>
              </div>
              <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
                {queueCount} shown
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {error ? (
                <div className="border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                  {error}
                </div>
              ) : !configured ? (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                  {objectLabel} durable hooks are not configured for this {selection.kind} scope.
                  {configureMeta && configurePath ? (
                    <Link
                      to={configurePath}
                      className="ml-2 inline-flex text-[var(--bo-accent)] hover:text-[var(--bo-accent-strong)]"
                    >
                      {configureMeta.label}
                    </Link>
                  ) : null}
                </div>
              ) : !hooksEnabled ? (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                  Durable hooks are disabled for this object. Enable durable hooks to begin queueing
                  work.
                </div>
              ) : queueCount === 0 ? (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3 text-sm text-[var(--bo-muted)]">
                  No durable hooks are queued right now.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="backoffice-scroll overflow-x-auto border border-[color:var(--bo-border)]">
                    <table className="min-w-full divide-y divide-[color:var(--bo-border)] text-sm">
                      <thead className="bg-[var(--bo-panel-2)] text-left">
                        <tr className="text-[11px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                          <th scope="col" className="px-3 py-2">
                            Hook
                          </th>
                          <th scope="col" className="px-3 py-2">
                            Status
                          </th>
                          <th scope="col" className="px-3 py-2">
                            Attempts
                          </th>
                          <th scope="col" className="px-3 py-2">
                            Last attempt
                          </th>
                          <th scope="col" className="px-3 py-2">
                            Next retry
                          </th>
                          <th scope="col" className="px-3 py-2">
                            Created
                          </th>
                          <th scope="col" className="px-3 py-2 text-right">
                            Detail
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[color:var(--bo-border)] bg-[var(--bo-panel)]">
                        {items.map((hook) => {
                          const isSelected = hook.id === selectedHookId;
                          const detailHref = `${objectBasePath}/${encodeURIComponent(hook.id)}${location.search}`;
                          return (
                            <tr
                              key={hook.id}
                              role="button"
                              tabIndex={0}
                              aria-label={`View durable hook ${hook.hookName}`}
                              onClick={() => void navigate(detailHref)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  void navigate(detailHref);
                                }
                              }}
                              className={
                                isSelected
                                  ? "cursor-pointer bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                                  : "cursor-pointer text-[var(--bo-muted)] hover:bg-[var(--bo-panel-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bo-accent)]"
                              }
                            >
                              <td className="px-3 py-2">
                                <div>
                                  <span
                                    className={
                                      isSelected
                                        ? "font-semibold text-[var(--bo-accent-fg)]"
                                        : "font-semibold text-[var(--bo-fg)]"
                                    }
                                  >
                                    {hook.hookName}
                                  </span>
                                  <p
                                    className={
                                      isSelected
                                        ? "text-xs text-[var(--bo-accent-fg)]/80"
                                        : "text-xs text-[var(--bo-muted-2)]"
                                    }
                                  >
                                    ID: {hook.id}
                                  </p>
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <span
                                  className={`border px-2 py-1 text-[10px] tracking-[0.22em] uppercase ${getStatusBadgeClasses(hook.status)}`}
                                >
                                  {hook.status}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                {hook.attempts} / {hook.maxAttempts}
                              </td>
                              <td className="px-3 py-2">
                                {formatTimestamp(hook.lastAttemptAt) || "-"}
                              </td>
                              <td className="px-3 py-2">
                                {formatTimestamp(hook.nextRetryAt) || "-"}
                              </td>
                              <td className="px-3 py-2">
                                {formatTimestamp(hook.createdAt) || "-"}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <Link
                                  to={detailHref}
                                  onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                                    event.stopPropagation();
                                  }}
                                  className={
                                    isSelected
                                      ? "text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase"
                                      : "text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase hover:text-[var(--bo-fg)]"
                                  }
                                >
                                  View
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--bo-muted-2)]">
                    <span>
                      {queueCount} hook{queueCount === 1 ? "" : "s"} shown
                    </span>
                    <div className="flex items-center gap-2">
                      {currentCursor ? (
                        <Link
                          to={newestPageHref}
                          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                        >
                          Newest
                        </Link>
                      ) : null}
                      {hasNextPage && nextPageHref ? (
                        <Link
                          to={nextPageHref}
                          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[9px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                        >
                          Next page
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div
            className={`${detailVisibility} min-w-0 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
          >
            <Outlet context={{ hooks: items, objectBasePath }} />
          </div>
        </section>
      )}
    </div>
  );
}
