import { Suspense, use, useSyncExternalStore } from "react";
import {
  Form,
  Link,
  Outlet,
  redirect,
  useActionData,
  useNavigation,
  useSearchParams,
} from "react-router";

import { BackofficeSystemState } from "@/components/backoffice";
import { useCurrentBackofficeContext } from "@/components/backoffice/current-context";
import { ClientOnly } from "@/components/client-only";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  describeAutomationCollectionSource,
  getAutomationBrowserDatabase,
  getAutomationCatchUpProgress,
  subscribeAutomationCatchUpProgress,
} from "@/fragno/automation/tanstack/browser-database";
import type { UploadCollectionSource } from "@/fragno/upload/tanstack/browser-database";
import { fetchUploadAdapterIdentity } from "@/fragno/upload/tanstack/server";

import { buildBackofficeLoginPath } from "../auth-navigation";
import type { Route } from "./+types/scope-layout";
import {
  createAutomationProject,
  loadAutomationWorkspaceData,
  lookupAutomationProject,
  toExternalId,
} from "./data.server";
import type { AutomationLayoutContext, AutomationTab } from "./layout-context";
import { QuakeTerminal } from "./quake-terminal";
import {
  automationScopeBasePath,
  automationScopeFromRouteParams,
  automationScopeTabPath,
  resolveAutomationUiScope,
  toBackofficeScope,
} from "./scope";
import {
  AutomationErrorBoundary,
  AutomationSubpageTabs,
  AutomationWorkspaceHeader,
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
  if (segments.includes("dashboard")) {
    return "dashboard";
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
  return "dashboard";
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
  const projectLookup =
    parsedRouteScope.kind === "project"
      ? await lookupAutomationProject(context, parsedRouteScope.orgId, parsedRouteScope.projectId)
      : null;
  if (projectLookup?.status === "error") {
    throw Response.json(
      {
        code: "AUTOMATION_PROJECT_UNAVAILABLE",
        message: projectLookup.message,
      },
      { status: 502, statusText: "Bad Gateway" },
    );
  }
  if (projectLookup?.status === "not-found") {
    throw new Response("Not Found", { status: 404 });
  }

  const selectedScope = resolveAutomationUiScope({
    params,
    organisations,
    project: projectLookup?.status === "found" ? projectLookup.project : null,
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
      ? fetchUploadAdapterIdentity(request, context, {
          kind: "org",
          orgId: selectedScope.orgId,
        })
          .then(
            (
              adapterIdentity,
            ): {
              source: UploadCollectionSource;
              error: null;
            } => ({
              source: {
                scope: { kind: "org", orgId: selectedScope.orgId },
                adapterIdentity,
              },
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
  const [workspaceResult, uploadCollectionState] = await Promise.all([
    loadAutomationWorkspaceData({
      request,
      context,
      scope: backofficeScope,
      layers: serverScriptLayers,
    }),
    uploadCollectionStatePromise,
  ]);

  return {
    selectedScope,
    scripts: workspaceResult.scripts,
    scriptsError: workspaceResult.scriptsError,
    uploadCollectionSource: uploadCollectionState.source,
    uploadCollectionError: uploadCollectionState.error,
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

  const result = await createAutomationProject(context, orgId, {
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
  const { automationCollectionSource } = useCurrentBackofficeContext();
  const resourceKey =
    automationCollectionSource.status === "ready"
      ? describeAutomationCollectionSource(automationCollectionSource.source).resourceKey
      : null;
  const progress = useSyncExternalStore(
    (listener) =>
      resourceKey ? subscribeAutomationCatchUpProgress(resourceKey, listener) : () => {},
    () => (resourceKey ? getAutomationCatchUpProgress(resourceKey) : null),
    () => null,
  );
  const progressDescription = progress
    ? `${progress.percent}%`
    : "Connecting routes, workflows, scripts, and runtime state for this scope.";

  return (
    <BackofficeSystemState
      tone="loading"
      label="Mounting workspace"
      title="Synchronizing automation data…"
      description={progressDescription}
    >
      <noscript>
        <span className="text-[var(--bo-failed)]">
          JavaScript is required to open scoped automations.
        </span>
      </noscript>
    </BackofficeSystemState>
  );
}

function AutomationClientOutlet({
  loaderData,
}: {
  loaderData: Route.ComponentProps["loaderData"];
}) {
  const { automationCollectionSource } = useCurrentBackofficeContext();
  if (automationCollectionSource.status === "unavailable") {
    return (
      <BackofficeSystemState
        tone="error"
        label="Unavailable"
        title="Automation synchronization failed."
        description={automationCollectionSource.message}
      />
    );
  }
  const collectionSource = automationCollectionSource.source;
  const { collections } = use(getAutomationBrowserDatabase(collectionSource));
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
  const activeStoreTab = currentPath.split("/").includes("identity-bindings")
    ? "identity-bindings"
    : "key-value";
  const storeBasePath = automationScopeTabPath(loaderData.selectedScope, "store");

  return (
    <div className="flex flex-1 flex-col">
      <AutomationWorkspaceHeader
        selectedScope={loaderData.selectedScope}
        isCreatingProject={isCreatingProject}
        activeTab={activeTab}
        subnav={
          activeTab === "store" && !isCreatingProject ? (
            <AutomationSubpageTabs
              tabs={[
                { id: "key-value", label: "Key-value", to: storeBasePath },
                {
                  id: "identity-bindings",
                  label: "Identity bindings",
                  to: `${storeBasePath}/identity-bindings`,
                },
              ]}
              activeTab={activeStoreTab}
              ariaLabel="Automation store sections"
            />
          ) : undefined
        }
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
      <QuakeTerminal selectedScope={loaderData.selectedScope} />
    </div>
  );
}
