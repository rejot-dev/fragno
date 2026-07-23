import { Suspense, use } from "react";
import {
  Form,
  Link,
  Outlet,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
} from "react-router";

import { ClientOnly } from "@/components/client-only";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
} from "@/fragno/automation/tanstack/browser-database";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/scope-layout";
import {
  createAutomationProject,
  fetchAutomationAdapterIdentity,
  fetchAutomationProjects,
  loadAutomationWorkspaceData,
  toExternalId,
} from "./data.server";
import type { AutomationLayoutContext, AutomationTab } from "./layout-context";
import {
  automationScopeBasePath,
  automationScopeFromRouteParams,
  automationScopeTabPath,
  createAutomationScopeOptions,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "./scope";
import {
  AutomationErrorBoundary,
  AutomationHeader,
  AutomationScopePicker,
  AutomationTabs,
} from "./shared";

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
  const serverScriptLayers =
    selectedScope.kind === "org"
      ? (["static"] as const)
      : selectedScope.kind === "system"
        ? (["system"] as const)
        : undefined;
  const uploadCollectionStatePromise =
    selectedScope.kind === "org" && currentTab === "scripts"
      ? fetchUploadAdapterIdentity(request, context, selectedScope.orgId)
          .then(
            (
              adapterIdentity,
            ): {
              source: UploadCollectionSource;
              error: null;
            } => ({
              source: { orgId: selectedScope.orgId, adapterIdentity },
              error: null,
            }),
          )
          .catch((error: unknown) => ({
            source: null,
            error:
              error instanceof Error
                ? error.message
                : "Local workspace script metadata is unavailable.",
          }))
      : Promise.resolve({ source: null, error: null });
  const [workspaceResult, adapterIdentity, uploadCollectionState] = await Promise.all([
    loadAutomationWorkspaceData({
      request,
      context,
      scope: backofficeScope,
      layers: serverScriptLayers,
    }),
    fetchAutomationAdapterIdentity(request, context, backofficeScope),
    uploadCollectionStatePromise,
  ]);

  return {
    selectedScope,
    adapterIdentity,
    scopeOptions: createAutomationScopeOptions({
      organisations,
      projects: projectsResult.projects,
      user: me.user,
      currentTab,
      projectOrgId: activeOrgId,
    }),
    scripts: workspaceResult.scripts,
    scriptsError: workspaceResult.scriptsError,
    uploadCollectionSource: uploadCollectionState.source,
    uploadCollectionError: uploadCollectionState.error,
    projectsError: projectsResult.projectsError,
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

function AutomationClientLoading() {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      Loading local automation data…
      <noscript>
        <span className="mt-2 block text-red-700 dark:text-red-200">
          JavaScript is required to open scoped automations.
        </span>
      </noscript>
    </div>
  );
}

function AutomationClientOutlet({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const database = use(getAutomationBrowserDatabase());
  const collectionSource = {
    scope: toBackofficeScope(loaderData.selectedScope),
    adapterIdentity: loaderData.adapterIdentity,
  };
  const collections = database.collectionsFor(collectionSource);
  const outletKey = describeAutomationCollectionSource(collectionSource).resourceKey;
  const outletContext = {
    selectedScope: loaderData.selectedScope,
    scripts: loaderData.scripts,
    scriptsError: loaderData.scriptsError,
    collections,
    uploadCollectionSource: loaderData.uploadCollectionSource,
    uploadCollectionError: loaderData.uploadCollectionError,
  } satisfies AutomationLayoutContext;

  return <Outlet key={outletKey} context={outletContext} />;
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
        <ClientOnly fallback={<AutomationClientLoading />}>
          <Suspense fallback={<AutomationClientLoading />}>
            <AutomationClientOutlet loaderData={loaderData} />
          </Suspense>
        </ClientOnly>
      )}
    </div>
  );
}
