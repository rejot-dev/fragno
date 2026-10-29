import { backofficeScopeOrganization } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { OverflowTabRow } from "@fragno-private/design-system/overflow-tab-row";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { useEffect } from "react";
import {
  Form,
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useNavigation,
  useParams,
} from "react-router";

import type { DurableHookCommands } from "@/backoffice-runtime/object-registry";
import {
  backofficeRouteScopeFromResolvedScope,
  backofficeRuntimeScopeFromResolvedScope,
} from "@/backoffice-runtime/resolved-scope";
import type { DurableHookQueueEntry, DurableHookQueueResponse } from "@/fragno/durable-hooks";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

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
  type DurableHooksScopeSelection,
} from "./durable-hooks-scope";
import { durableHookStatusTone, formatTimestamp } from "./durable-hooks-shared";

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

const HOOK_COLUMNS: SurfaceTableColumn[] = [
  { label: "Hook", align: "start" },
  { label: "Status", align: "start" },
  { label: "Attempts", align: "end" },
  { label: "Last attempt", align: "start" },
  { label: "Next retry", align: "start" },
  { label: "Created", align: "start" },
];

const parsePageSize = (value: string | null) => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The hook commands of the object a selection names; Workflows' hooks live in Automations. */
function durableHookObjectCommands({
  context,
  selection,
}: {
  context: Route.LoaderArgs["context"];
  selection: DurableHooksScopeSelection;
}): DurableHookCommands {
  const objects = getBackofficeObjects(context);
  const runtimeScope = backofficeRuntimeScopeFromResolvedScope(selection.resolvedScope);

  switch (selection.objectId) {
    case "api":
      return objects.api.for(runtimeScope).commands;
    case "auth":
      return objects.auth.for(runtimeScope).commands;
    case "forms":
      return objects.forms.singleton().commands;
    case "telegram":
      return objects.telegram.for(runtimeScope).commands;
    case "otp":
      return objects.otp.for(runtimeScope).commands;
    case "resend":
      return objects.resend.for(runtimeScope).commands;
    case "mcp":
      return objects.mcp.for(runtimeScope).commands;
    case "upload":
      return objects.upload.for(runtimeScope).commands;
    case "github":
      return objects.github.for(runtimeScope).commands;
    case "automations":
    case "workflows": {
      const automations = objects.automations.for(runtimeScope).commands;
      const fragment = selection.objectId === "automations" ? "automation" : "workflows";
      return {
        getDurableHookQueue: async (options) =>
          await automations.getDurableHookQueue(fragment, options),
        getDurableHook: async (hookId) => await automations.getDurableHook(fragment, hookId),
        wakeDurableHooks: async () => {
          await automations.wakeDurableHooks();
        },
      };
    }
  }

  throw new Error("Unsupported durable hooks object.");
}

function resolveRequestedSelection(
  context: Route.LoaderArgs["context"],
  objectId: string | undefined,
) {
  const scope = requireScopeSelection(context);
  return {
    scope,
    requestedSelection: resolveDurableHooksScopeSelection({ scope, objectId }),
  };
}

export async function loader({ params, context, url }: Route.LoaderArgs) {
  const { scope, requestedSelection } = resolveRequestedSelection(context, params.objectId);
  const selection =
    requestedSelection ??
    resolveDurableHooksScopeSelection({
      scope,
      objectId: defaultDurableHooksObjectForScope(backofficeRuntimeScopeFromResolvedScope(scope)),
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
    const queue = await durableHookObjectCommands({ context, selection }).getDurableHookQueue({
      cursor,
      pageSize,
    });
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

/**
 * Wakes the selected object's hooks: its alarm fires now, so the hooks it left pending run even when
 * the alarm that should have run them was lost.
 */
export async function action({ params, context }: Route.ActionArgs) {
  const { requestedSelection } = resolveRequestedSelection(context, params.objectId);
  if (!requestedSelection) {
    throw new Response("Not Found", { status: 404 });
  }
  await durableHookObjectCommands({ context, selection: requestedSelection }).wakeDurableHooks();
  return { woke: true };
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
    // The scope policy in the Backoffice object registry decides which objects are listed.
    <OverflowTabRow
      items={options.map((option) => ({
        id: option.id,
        label: option.label,
        to: option.to,
        active: option.id === selectedObjectId,
      }))}
      ariaLabel="Durable hook objects"
      variant="underline"
      trailing={null}
    />
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
  const waking = useNavigation().state === "submitting";
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
  const configureOrgSlug = backofficeScopeOrganization(selectionRouteScope)?.orgSlug;
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

  useEffect(() => {
    if (!selectedHookId || items.some((item) => item.id === selectedHookId)) {
      return;
    }

    void navigate(`${objectBasePath}${location.search}`, { replace: true });
  }, [items, selectedHookId, objectBasePath, location.search, navigate]);

  return (
    <>
      <DurableHooksObjectPicker
        selectedObjectId={objectNotFound ? null : selection.objectId}
        options={objectOptions}
      />

      {objectNotFound ? (
        <BackofficeSystemState
          tone="error"
          label="404 · Not found"
          title="Durable object not found."
          description={`This fragment or Durable Object is not available in the ${selection.kind} scope ${selection.label}.`}
        />
      ) : (
        <section className="grid min-w-0 items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div className={`${listVisibility} min-w-0`}>
            <SurfacePanel
              caption={`${objectLabel} queue · ${queueCount} shown`}
              actions={
                <div className="flex items-center gap-3">
                  {namespace ? (
                    <span className="font-mono text-xs text-[var(--bo-muted-2)]">{namespace}</span>
                  ) : null}
                  {configured && hooksEnabled ? (
                    // Recovers hooks left pending by a lost alarm; firing it early is harmless.
                    <Form method="post">
                      <Button type="submit" variant="secondary" disabled={waking}>
                        {waking ? "Waking…" : "Wake hooks"}
                      </Button>
                    </Form>
                  ) : null}
                </div>
              }
            >
              {error ? (
                <SurfacePanelBody>
                  <InlineAlert>{error}</InlineAlert>
                </SurfacePanelBody>
              ) : !configured ? (
                <BackofficeSystemState
                  tone="empty"
                  label="Not configured"
                  title={`${objectLabel} is not configured for this ${selection.kind} scope.`}
                  description="Its durable hooks queue once the fragment is configured."
                  actions={
                    configureMeta && configurePath ? (
                      <ButtonLink to={configurePath} variant="accent">
                        {configureMeta.label}
                      </ButtonLink>
                    ) : null
                  }
                  flush
                />
              ) : !hooksEnabled ? (
                <BackofficeSystemState
                  tone="empty"
                  label="Disabled"
                  title="Durable hooks are disabled for this object."
                  description="Enable durable hooks to begin queueing work."
                  flush
                />
              ) : queueCount === 0 ? (
                <BackofficeSystemState
                  tone="empty"
                  title="No durable hooks are queued right now."
                  description="Hooks appear here while they wait, retry, or after they settle."
                  flush
                />
              ) : (
                <SurfaceTable columns={HOOK_COLUMNS}>
                  {items.map((hook) => {
                    const isSelected = hook.id === selectedHookId;
                    return (
                      <SurfaceTableRow
                        key={hook.id}
                        columns={HOOK_COLUMNS}
                        cells={[
                          <div key="hook" className="min-w-0">
                            <Link
                              to={`${objectBasePath}/${encodeURIComponent(hook.id)}${location.search}`}
                              aria-current={isSelected ? "page" : undefined}
                              aria-label={`View durable hook ${hook.hookName}`}
                              className={`font-semibold hover:underline ${
                                isSelected ? "text-[var(--bo-accent-fg)]" : "text-[var(--bo-fg)]"
                              }`}
                            >
                              {hook.hookName}
                            </Link>
                            <p className="font-mono text-[11px] text-[var(--bo-muted-2)]">
                              {hook.id}
                            </p>
                          </div>,
                          <BackofficeStatusLight
                            key="status"
                            tone={durableHookStatusTone(hook.status)}
                          >
                            {hook.status}
                          </BackofficeStatusLight>,
                          `${hook.attempts} / ${hook.maxAttempts}`,
                          <span key="last" className="whitespace-nowrap">
                            {formatTimestamp(hook.lastAttemptAt) || "—"}
                          </span>,
                          <span key="next" className="whitespace-nowrap">
                            {formatTimestamp(hook.nextRetryAt) || "—"}
                          </span>,
                          <span key="created" className="whitespace-nowrap">
                            {formatTimestamp(hook.createdAt) || "—"}
                          </span>,
                        ]}
                      />
                    );
                  })}
                </SurfaceTable>
              )}
              {currentCursor || (hasNextPage && nextPageHref) ? (
                <SurfacePanelFooter>
                  {currentCursor ? (
                    <ButtonLink to={newestPageHref} variant="secondary">
                      Newest
                    </ButtonLink>
                  ) : null}
                  {hasNextPage && nextPageHref ? (
                    <ButtonLink to={nextPageHref} variant="secondary">
                      Next page
                    </ButtonLink>
                  ) : null}
                </SurfacePanelFooter>
              ) : null}
            </SurfacePanel>
          </div>

          <div className={`${detailVisibility} min-w-0`}>
            <Outlet context={{ hooks: items, objectBasePath }} />
          </div>
        </section>
      )}
    </>
  );
}
