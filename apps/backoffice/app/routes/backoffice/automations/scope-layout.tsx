import { useMemo } from "react";
import {
  Form,
  Link,
  Outlet,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
} from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/scope-layout";
import {
  createAutomationProject,
  fetchAutomationEventDefinitions,
  fetchAutomationEvents,
  fetchAutomationProjects,
  fetchAutomationRoutes,
  fetchAutomationStoreEntries,
  loadAutomationWorkspaceData,
  toExternalId,
} from "./data.server";
import { useLofiAutomationScopeData } from "./lofi-store";
import {
  automationScopeBasePath,
  automationScopeFromRouteParams,
  automationScopeTabPath,
  createAutomationScopeOptions,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "./scope";
import type {
  AutomationEventItem,
  AutomationRouteItem,
  AutomationScriptItem,
  AutomationStoreItem,
} from "./shared";
import {
  AutomationErrorBoundary,
  AutomationHeader,
  AutomationScopePicker,
  AutomationTabs,
  resolveAutomationServerLofiData,
  type AutomationTab,
} from "./shared";

const DEFAULT_EVENTS_PAGE_SIZE = 10;
const MAX_EVENTS_PAGE_SIZE = 10;

const parseEventsPageSize = (value: string | null) => {
  if (!value) {
    return DEFAULT_EVENTS_PAGE_SIZE;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EVENTS_PAGE_SIZE;
  }

  return Math.min(MAX_EVENTS_PAGE_SIZE, Math.max(1, parsed));
};

const normalizeScripts = (
  scripts: Awaited<ReturnType<typeof loadAutomationWorkspaceData>>["scripts"],
): AutomationScriptItem[] => {
  return scripts
    .map((script) => ({
      id: script.id,
      key: script.key,
      name: script.name,
      engine: script.engine,
      layer: script.layer,
      readOnly: script.readOnly,
      script: null,
      path: script.path,
      absolutePath: script.absolutePath,
      version: script.version,
      scriptLoadError: script.scriptLoadError ?? null,
      enabled: script.enabled,
    }))
    .sort(
      (left, right) =>
        left.layer.localeCompare(right.layer) ||
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path),
    );
};

const normalizeRoutes = (
  routes: Awaited<ReturnType<typeof fetchAutomationRoutes>>["routes"],
): AutomationRouteItem[] =>
  [...routes].sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );

const normalizeEventDefinitions = (
  definitions: Awaited<ReturnType<typeof fetchAutomationEventDefinitions>>["eventDefinitions"],
) =>
  [...definitions].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.eventType.localeCompare(right.eventType),
  );

const normalizeEvents = (
  events: Awaited<ReturnType<typeof fetchAutomationEvents>>["events"],
): AutomationEventItem[] =>
  events
    .map((event) => ({
      id: toExternalId(event.id),
      scope: event.scope,
      source: event.source,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: event.payload,
      actor: event.actor,
      actors: Array.isArray(event.actors) ? event.actors : [],
      subject: event.subject ?? null,
      createdAt: event.createdAt,
    }))
    .sort((left, right) => {
      const occurred = String(right.occurredAt ?? "").localeCompare(String(left.occurredAt ?? ""));
      return occurred || right.id.localeCompare(left.id);
    });

const normalizeStoreEntries = (
  storedEntries: Awaited<ReturnType<typeof fetchAutomationStoreEntries>>["storeEntries"],
) => {
  const entries: AutomationStoreItem[] = storedEntries.map((entry, index) => ({
    id: toExternalId(entry.id) || `store-entry-${index}`,
    key: entry.key?.trim() || "—",
    value: entry.value?.trim() || "—",
    description: entry.description ?? null,
    category: Array.isArray(entry.category) ? entry.category : [],
    actor: entry.actor ?? null,
    createdAt: entry.createdAt ?? null,
    updatedAt: entry.updatedAt ?? null,
  }));

  return entries.sort((left, right) => left.key.localeCompare(right.key));
};

type ProjectActionData = { ok: false; message: string };

const optionalText = (value: FormDataEntryValue | null) => {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
};

const nullableText = (value: FormDataEntryValue | null) => {
  const text = String(value ?? "").trim();
  return text ? text : null;
};

const currentTabFromPath = (pathname: string): AutomationTab => {
  const segments = pathname.replace(/\/+$/, "").split("/");
  if (segments.includes("terminal")) {
    return "terminal";
  }
  if (segments.includes("sandboxes")) {
    return "sandboxes";
  }
  if (segments.includes("mcp")) {
    return "mcp";
  }
  if (segments.includes("integrations")) {
    return "integrations";
  }
  if (segments.includes("router")) {
    return "router";
  }
  if (segments.includes("api")) {
    return "api";
  }
  if (segments.includes("events-catalog")) {
    return "events-catalog";
  }
  if (segments.includes("events")) {
    return "events";
  }
  if (segments.includes("store")) {
    return "store";
  }
  if (segments.includes("scripts")) {
    return "scripts";
  }
  return "terminal";
};

export async function loader({ request, params, context, url }: Route.LoaderArgs) {
  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(
      new URL(buildBackofficeLoginPath(`${url.pathname}${url.search}`), request.url),
      302,
    );
  }

  const organisations = me.organizations.map((entry) => entry.organization);
  let parsedRouteScope;
  try {
    parsedRouteScope = automationScopeFromRouteParams(params);
  } catch {
    throw new Response("Not Found", { status: 404 });
  }
  const selectedRouteScope =
    parsedRouteScope?.kind === "project" || parsedRouteScope?.kind === "org"
      ? parsedRouteScope.orgId
      : undefined;
  const activeOrgId =
    selectedRouteScope ?? me.activeOrganization?.organization.id ?? organisations[0]?.id ?? null;
  if (!activeOrgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const projectsResult = await fetchAutomationProjects(request, context, activeOrgId);
  if (params.scopeKind === "project" && projectsResult.projectsError) {
    throw Response.json(
      {
        code: "AUTOMATION_PROJECTS_UNAVAILABLE",
        message: projectsResult.projectsError,
      },
      { status: 502, statusText: "Bad Gateway" },
    );
  }

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    projects: projectsResult.projects,
    user: me.user,
  });
  const backofficeScope = toBackofficeScope(selectedScope);
  const currentTab = currentTabFromPath(url.pathname);
  const eventsCursor = url.searchParams.get("cursor")?.trim() || undefined;
  const eventsPageSize = parseEventsPageSize(url.searchParams.get("pageSize"));

  const [workspaceResult, routesResult, storeResult, eventsResult, eventDefinitionsResult] =
    await Promise.all([
      loadAutomationWorkspaceData({ request, context, scope: backofficeScope }),
      fetchAutomationRoutes(request, context, backofficeScope),
      fetchAutomationStoreEntries(request, context, backofficeScope),
      fetchAutomationEvents(request, context, backofficeScope, {
        cursor: eventsCursor,
        limit: eventsPageSize,
      }),
      fetchAutomationEventDefinitions(request, context, backofficeScope),
    ]);

  return {
    orgId:
      selectedScope.kind === "org" || selectedScope.kind === "project"
        ? selectedScope.orgId
        : activeOrgId,
    organisation:
      organisations.find((organisation) => organisation.id === activeOrgId) ?? organisations[0],
    user: me.user,
    selectedScope,
    scopeOptions: createAutomationScopeOptions({
      organisations,
      projects: projectsResult.projects,
      user: me.user,
      currentTab,
      projectOrgId: activeOrgId,
    }),
    scripts: normalizeScripts(workspaceResult.scripts),
    routes: normalizeRoutes(routesResult.routes),
    storeEntries: normalizeStoreEntries(storeResult.storeEntries),
    events: normalizeEvents(eventsResult.events),
    eventDefinitions: normalizeEventDefinitions(eventDefinitionsResult.eventDefinitions),
    eventsCursor: eventsResult.cursor,
    eventsHasNextPage: eventsResult.hasNextPage,
    eventsCurrentCursor: eventsCursor ?? null,
    eventsPageSize,
    scriptsError: workspaceResult.scriptsError,
    routesError: routesResult.routesError,
    storeEntriesError: storeResult.storeEntriesError,
    eventsError: eventsResult.eventsError,
    eventDefinitionsError: eventDefinitionsResult.eventDefinitionsError,
    projectsError: projectsResult.projectsError,
    storePrefix: url.searchParams.get("prefix") ?? "",
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const label = loaderData?.selectedScope.label ?? "scope";
  return [{ title: `Automations · ${label}` }];
}

export async function action({ request, params, context, url }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "create-project") {
    return { ok: false, message: "Unknown automation action." } satisfies ProjectActionData;
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    throw redirect(buildBackofficeLoginPath(`${url.pathname}${url.search}`));
  }

  const scope = automationScopeFromRouteParams(params);
  const orgId =
    scope.kind === "org" || scope.kind === "project"
      ? scope.orgId
      : (me.activeOrganization?.organization.id ?? me.organizations[0]?.organization.id ?? null);
  if (!orgId || !me.organizations.some((entry) => entry.organization.id === orgId)) {
    throw new Response("Not Found", { status: 404 });
  }

  const name = optionalText(formData.get("name"));
  if (!name) {
    return { ok: false, message: "Project name is required." } satisfies ProjectActionData;
  }

  const result = await createAutomationProject(request, context, orgId, {
    name,
    description: nullableText(formData.get("description")),
    createdByUserId: me.user.id,
  });
  if (result.error || !result.project) {
    return {
      ok: false,
      message: result.error ?? "Unable to create project.",
    } satisfies ProjectActionData;
  }

  const projectId = toExternalId(result.project.id);
  if (!projectId) {
    return {
      ok: false,
      message: "Created project did not return an id.",
    } satisfies ProjectActionData;
  }

  return redirect(
    automationScopeTabPath({
      kind: "project",
      orgId,
      projectId,
      label: result.project.name ?? name,
    }),
  );
}

export function ErrorBoundary({ error, params }: Route.ErrorBoundaryProps) {
  return <AutomationErrorBoundary error={error} params={params} />;
}

function CreateProjectPanel({
  actionPath,
  cancelPath,
}: {
  actionPath: string;
  cancelPath: string;
}) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "create-project";

  return (
    <section className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
            New project
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-[var(--bo-fg)]">Create project</h2>
          <p className="mt-1 text-sm text-[var(--bo-muted)]">
            The project slug is generated automatically from the name.
          </p>
        </div>
        <Link
          to={cancelPath}
          preventScrollReset
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Cancel
        </Link>
      </div>

      {actionData?.message ? (
        <div className="mt-4 border border-red-400/40 bg-red-500/8 p-3 text-sm text-red-700 dark:text-red-200">
          <p className="text-[10px] tracking-[0.22em] uppercase">Project action failed</p>
          <p className="mt-2">{actionData.message}</p>
        </div>
      ) : null}

      <Form method="post" action={actionPath} className="mt-4 max-w-2xl space-y-4">
        <input type="hidden" name="intent" value="create-project" />
        <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Name
          </span>
          <input
            name="name"
            required
            maxLength={160}
            placeholder="Launch Plan"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--bo-muted)]">
          <span className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
            Description
          </span>
          <textarea
            name="description"
            maxLength={1000}
            rows={4}
            placeholder="What this project owns."
            className="resize-y border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-fg)] outline-none focus:border-[color:var(--bo-accent)]"
          />
        </label>
        <button
          type="submit"
          disabled={isSubmitting}
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "Creating…" : "Create project"}
        </button>
      </Form>
    </section>
  );
}

export default function BackofficeAutomationScopeLayout({
  loaderData,
  matches,
}: Route.ComponentProps) {
  const currentPath = (matches[matches.length - 1]?.pathname || "").replace(/\/+$/, "");
  const activeTab = currentTabFromPath(currentPath);
  const [searchParams] = useSearchParams();
  const isCreatingProject = searchParams.get("createProject") === "1";
  const scopeBasePath = automationScopeBasePath(loaderData.selectedScope);
  const lofi = useLofiAutomationScopeData({
    scope: loaderData.selectedScope,
    initialEntries: loaderData.storeEntries,
    initialRoutes: loaderData.routes,
    initialEvents: loaderData.events,
    initialEventDefinitions: loaderData.eventDefinitions,
    prefix: loaderData.storePrefix,
  });
  const outletContext = useMemo(() => {
    const storeData = resolveAutomationServerLofiData({
      serverData: loaderData.storeEntries,
      serverError: loaderData.storeEntriesError,
      lofiData: lofi.store.entries,
      lofiSynced: lofi.store.synced,
      lofiError: lofi.store.error,
      isEmpty: (entries) => entries.length === 0,
    });
    const routesData = resolveAutomationServerLofiData({
      serverData: loaderData.routes,
      serverError: loaderData.routesError,
      lofiData: lofi.routes.routes,
      lofiSynced: lofi.routes.synced,
      lofiError: lofi.routes.error,
      isEmpty: (routes) => routes.length === 0,
    });
    const eventsData = resolveAutomationServerLofiData({
      serverData: loaderData.events,
      serverError: loaderData.eventsError,
      lofiData: lofi.events.events.slice(0, loaderData.eventsPageSize),
      lofiSynced: !loaderData.eventsCurrentCursor && lofi.events.synced,
      lofiError: lofi.events.error,
      isEmpty: (events) => events.length === 0,
    });
    const eventDefinitionsData = resolveAutomationServerLofiData({
      serverData: loaderData.eventDefinitions,
      serverError: loaderData.eventDefinitionsError,
      lofiData: lofi.eventDefinitions.eventDefinitions,
      lofiSynced: lofi.eventDefinitions.synced,
      lofiError: lofi.eventDefinitions.error,
      isEmpty: (definitions) => definitions.length === 0,
    });

    return {
      ...loaderData,
      routes: routesData.data,
      storeEntries: storeData.data,
      events: eventsData.data,
      eventDefinitions: eventDefinitionsData.data,
      storeData,
      routesData,
      eventsData,
      eventDefinitionsData,
      lofiStore: { ...lofi.store, entries: storeData.data, error: storeData.syncError },
      lofiRoutes: { ...lofi.routes, routes: routesData.data, error: routesData.syncError },
      lofiEvents: { ...lofi.events, events: eventsData.data, error: eventsData.syncError },
      lofiEventDefinitions: {
        ...lofi.eventDefinitions,
        eventDefinitions: eventDefinitionsData.data,
        error: eventDefinitionsData.syncError,
      },
      lofiSandboxes: lofi.sandboxes,
    };
  }, [loaderData, lofi]);

  return (
    <div className="space-y-4">
      <AutomationHeader selectedScope={loaderData.selectedScope} />
      <AutomationScopePicker
        selectedScope={loaderData.selectedScope}
        scopeOptions={loaderData.scopeOptions}
        projectsError={loaderData.projectsError}
        createProjectPath={`${currentPath}?createProject=1`}
        isCreatingProject={isCreatingProject}
      />
      <AutomationTabs
        selectedScope={loaderData.selectedScope}
        activeTab={activeTab}
        disabled={isCreatingProject}
      />
      {isCreatingProject ? (
        <CreateProjectPanel actionPath={scopeBasePath} cancelPath={currentPath} />
      ) : (
        <Outlet context={outletContext} />
      )}
    </div>
  );
}
