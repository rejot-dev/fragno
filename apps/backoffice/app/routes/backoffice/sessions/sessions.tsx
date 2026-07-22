import { ScrollArea } from "@base-ui/react/scroll-area";
import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import {
  Form,
  Link,
  Outlet,
  redirect,
  useActionData,
  useNavigation,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router";

import { ClientOnly } from "@/components/client-only";
import { getAuthMe } from "@/fragno/auth/auth-server";
import {
  createPiAgentName,
  findPiModelOption,
  PI_MODEL_CATALOG,
  resolvePiHarnesses,
  resolvePiModelThinkingLevel,
  type PiHarnessConfig,
} from "@/fragno/pi/pi-shared";
import type { PiSessionListingState } from "@/fragno/pi/tanstack/session-listing";
import { usePiSessionListing } from "@/fragno/pi/tanstack/use-session-listing";

import type { Route } from "./+types/sessions";
import { createPiSession, fetchPiConfig } from "./data";
import { formatTimestamp } from "./formatting";
import type { PiLayoutContext } from "./shared";

type PiCreateSessionActionData = {
  intent: "create-session";
  ok: boolean;
  message?: string;
};

export type PiSessionsOutletContext = {
  scope: PiLayoutContext["scope"];
  persistenceSource: NonNullable<PiLayoutContext["persistenceSource"]>;
  harnesses: PiHarnessConfig[];
  basePath: string;
  createSessionPanel?: ReactNode;
};

const PI_SESSIONS_LOADING = <PiSessionsLoading />;

export async function action({ request, params, context }: Route.ActionArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const me = await getAuthMe(request, context);
  if (!me?.user) {
    return Response.redirect(new URL("/backoffice/login", request.url), 302);
  }

  const organisation =
    me.organizations.find((entry) => entry.organization.id === params.orgId)?.organization ?? null;
  if (!organisation) {
    throw new Response("Not Found", { status: 404 });
  }

  const scope = { kind: "org" as const, orgId: params.orgId };
  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const harnessId = getValue("harnessId");
  const modelOption = getValue("modelOption");
  const name = getValue("name");
  if (!harnessId) {
    return {
      intent: "create-session",
      ok: false,
      message: "Harness selection is required.",
    } satisfies PiCreateSessionActionData;
  }

  if (!modelOption) {
    return {
      intent: "create-session",
      ok: false,
      message: "Model selection is required.",
    } satisfies PiCreateSessionActionData;
  }

  const [providerRaw, ...modelParts] = modelOption.split("::");
  const model = modelParts.join("::");
  if (!providerRaw || !model) {
    return {
      intent: "create-session",
      ok: false,
      message: "Model selection is invalid.",
    } satisfies PiCreateSessionActionData;
  }

  const modelSelection = findPiModelOption(providerRaw as "openai" | "anthropic" | "gemini", model);
  if (!modelSelection) {
    return {
      intent: "create-session",
      ok: false,
      message: "Model selection is invalid.",
    } satisfies PiCreateSessionActionData;
  }

  const { configState, configError } = await fetchPiConfig(context, scope);
  if (configError) {
    return {
      intent: "create-session",
      ok: false,
      message: configError,
    } satisfies PiCreateSessionActionData;
  }
  if (!configState?.configured) {
    return {
      intent: "create-session",
      ok: false,
      message: "Pi is not configured yet.",
    } satisfies PiCreateSessionActionData;
  }

  const harness = configState?.config?.harnesses?.find((entry) => entry.id === harnessId);
  if (!harness) {
    return {
      intent: "create-session",
      ok: false,
      message: "Selected harness is unavailable.",
    } satisfies PiCreateSessionActionData;
  }

  const apiKeyPreview = configState?.config?.apiKeys?.[modelSelection.provider];
  if (!apiKeyPreview) {
    return {
      intent: "create-session",
      ok: false,
      message: `Missing API key for ${modelSelection.provider}.`,
    } satisfies PiCreateSessionActionData;
  }

  const agent = createPiAgentName({
    harnessId: harness.id,
    provider: modelSelection.provider,
    model: modelSelection.name,
  });

  const result = await createPiSession(request, context, scope, {
    workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
    input: {
      harnessName: agent,
      thinkingLevel: resolvePiModelThinkingLevel(modelSelection.provider),
    },
    name: name || undefined,
  });

  if (result.error || !result.session) {
    return {
      intent: "create-session",
      ok: false,
      message: result.error ?? "Failed to create session.",
    } satisfies PiCreateSessionActionData;
  }

  return redirect(
    `/backoffice/sessions/${params.orgId}/sessions/${encodeURIComponent(result.session.workflowName)}/${encodeURIComponent(result.session.id)}`,
  );
}

export default function BackofficeOrganisationPiSessionsLayout() {
  const layoutContext = useOutletContext<PiLayoutContext>();

  if (!layoutContext.persistenceSource) {
    return <PiSessionsUnavailable layoutContext={layoutContext} />;
  }

  return (
    <ClientOnly fallback={PI_SESSIONS_LOADING}>
      <Suspense fallback={PI_SESSIONS_LOADING}>
        <SynchronizedPiSessionsLayout
          layoutContext={layoutContext}
          source={layoutContext.persistenceSource}
        />
      </Suspense>
    </ClientOnly>
  );
}

function PiSessionsLoading() {
  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      Loading local Pi sessions…
      <noscript>
        <span className="mt-2 block text-red-700 dark:text-red-200">
          JavaScript is required to open Pi sessions.
        </span>
      </noscript>
    </div>
  );
}

function PiSessionsUnavailable({ layoutContext }: { layoutContext: PiLayoutContext }) {
  const message =
    layoutContext.configError ??
    layoutContext.persistenceError ??
    (layoutContext.configState?.configured
      ? "Local Pi session persistence is unavailable."
      : "Configure Pi before opening sessions.");

  return (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
      {message}
    </div>
  );
}

function SynchronizedPiSessionsLayout({
  layoutContext,
  source,
}: {
  layoutContext: PiLayoutContext;
  source: NonNullable<PiLayoutContext["persistenceSource"]>;
}) {
  const listingState = usePiSessionListing({
    source,
    workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
  });

  if (listingState.status === "synchronizing" && listingState.snapshot.sessions.length === 0) {
    return <PiSessionsLoading />;
  }

  return (
    <PiSessionsLayoutView
      layoutContext={layoutContext}
      source={source}
      listingState={listingState}
    />
  );
}

function PiSessionsLayoutView({
  layoutContext,
  source,
  listingState,
}: {
  layoutContext: PiLayoutContext;
  source: NonNullable<PiLayoutContext["persistenceSource"]>;
  listingState: PiSessionListingState;
}) {
  const actionData = useActionData<typeof action>() as PiCreateSessionActionData | undefined;
  const navigation = useNavigation();
  const { scope, configState } = layoutContext;
  const orgId = scope.orgId;
  const { sessionId, workflowName } = useParams();
  const [searchParams] = useSearchParams();
  const selectedWorkflowName = workflowName ?? null;
  const selectedSessionId = sessionId ?? null;
  const isNewSession = searchParams.get("new") === "1";
  const basePath = `/backoffice/sessions/${orgId}/sessions`;
  const isDetailRoute = Boolean(selectedSessionId);
  const { sessions, workflowStatuses } = listingState.snapshot;
  const listingError = listingState.status === "error" ? listingState.error : null;
  const activeIntent = navigation.formData?.get("intent");
  const creating = navigation.state === "submitting" && activeIntent === "create-session";
  const harnesses = resolvePiHarnesses(configState?.config?.harnesses);
  const [preferredHarnessId, setPreferredHarnessId] = useState("");
  const selectedHarnessId = harnesses.some((harness) => harness.id === preferredHarnessId)
    ? preferredHarnessId
    : (harnesses[0]?.id ?? "");
  const apiKeys = configState?.config?.apiKeys;
  const availableModelOptions = useMemo(
    () => PI_MODEL_CATALOG.filter((option) => Boolean(apiKeys?.[option.provider])),
    [apiKeys],
  );
  const [preferredModelOption, setPreferredModelOption] = useState("");
  const selectedModelOption = availableModelOptions.some(
    (option) => `${option.provider}::${option.name}` === preferredModelOption,
  )
    ? preferredModelOption
    : availableModelOptions[0]
      ? `${availableModelOptions[0].provider}::${availableModelOptions[0].name}`
      : "";

  const selectedHarness = useMemo(
    () => harnesses.find((entry) => entry.id === selectedHarnessId) ?? null,
    [harnesses, selectedHarnessId],
  );

  const isDetailView = isDetailRoute || isNewSession;
  // Use flex for both; max-lg:hidden only applies below lg so lg layout stays stable
  const listVisibility = isDetailView ? "max-lg:hidden lg:flex" : "flex";
  const detailVisibility = "block";
  const createError =
    actionData?.intent === "create-session" && !actionData.ok ? actionData.message : null;
  const createSessionPanel = (
    <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
      <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
        New session
      </p>
      <p className="mt-2 text-sm text-[var(--bo-muted)]">
        Pick a harness and model to start a new Pi agent workflow.
      </p>

      {harnesses.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--bo-muted)]">
          No harnesses configured yet. Add harnesses in configuration before creating sessions.
        </p>
      ) : (
        <Form method="post" action={`${basePath}?new=1`} className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="create-session" />
          {createError ? <p className="text-xs text-red-500">{createError}</p> : null}

          <div className="space-y-2">
            <label className="text-xs font-semibold text-[var(--bo-fg)]">Harness</label>
            <select
              name="harnessId"
              required
              value={selectedHarnessId}
              onChange={(event) => {
                setPreferredHarnessId(event.target.value);
              }}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            >
              {harnesses.map((harness) => (
                <option key={harness.id} value={harness.id}>
                  {harness.label}
                </option>
              ))}
            </select>
            {selectedHarness?.description ? (
              <p className="text-xs text-[var(--bo-muted-2)]">{selectedHarness.description}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-[var(--bo-fg)]">Model</label>
            <input type="hidden" name="modelOption" value={selectedModelOption} required />
            <div
              role="radiogroup"
              aria-label="Model selection"
              className="flex flex-wrap gap-2 rounded border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-2"
            >
              {availableModelOptions.length === 0 ? (
                <p className="text-xs text-[var(--bo-muted)]">
                  Configure an API key to enable model selection.
                </p>
              ) : (
                availableModelOptions.map((option) => {
                  const value = `${option.provider}::${option.name}`;
                  const isSelected = selectedModelOption === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => {
                        setPreferredModelOption(value);
                      }}
                      className={`border px-2 py-1 text-[10px] font-semibold tracking-[0.22em] uppercase ${
                        isSelected
                          ? "border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] text-[var(--bo-accent-fg)]"
                          : "border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] text-[var(--bo-muted)] hover:border-[color:var(--bo-accent)] hover:text-[var(--bo-fg)]"
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="new-session-name" className="text-xs font-semibold text-[var(--bo-fg)]">
              Session name
            </label>
            <input
              id="new-session-name"
              type="text"
              name="name"
              placeholder="Optional session title"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            />
          </div>

          <button
            type="submit"
            disabled={creating || availableModelOptions.length === 0}
            className="w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-2 text-[11px] font-semibold tracking-[0.22em] text-[var(--bo-accent-fg)] uppercase transition-colors hover:border-[color:var(--bo-accent-strong)] disabled:opacity-60"
          >
            {creating ? "Creating…" : "Create session"}
          </button>
        </Form>
      )}
    </div>
  );
  const newSessionLinkClass = isNewSession
    ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
    : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]";

  return (
    <section className="grid min-h-0 flex-1 grid-rows-1 gap-4 lg:grid-cols-[minmax(280px,420px)_minmax(0,1fr)]">
      <div
        className={`${listVisibility} flex min-h-0 flex-col gap-4 border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] tracking-[0.24em] text-[var(--bo-muted-2)] uppercase">
              Sessions
            </p>
            <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">Session overview</h2>
          </div>
          <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 text-[10px] tracking-[0.22em] text-[var(--bo-muted)] uppercase">
            {sessions.length} total
          </span>
        </div>

        <Link to={`${basePath}?new=1`} className={newSessionLinkClass}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[var(--bo-fg)]">New session</p>
            <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
              Create
            </span>
          </div>
        </Link>

        {listingError ? (
          <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            {listingError}
          </div>
        ) : null}

        <ScrollArea.Root className="relative mt-3 flex min-h-0 flex-1 overflow-hidden">
          <ScrollArea.Viewport className="min-h-0 flex-1 pr-1">
            <ScrollArea.Content className="space-y-2">
              {sessions.length === 0 ? (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
                  No sessions yet. Use the new session button above to get started.
                </div>
              ) : (
                sessions.map((session) => {
                  const workflowStatus = workflowStatuses[session.id] ?? "unknown";
                  const isSelected =
                    session.workflowName === selectedWorkflowName &&
                    session.id === selectedSessionId;
                  const [harnessId, provider, model] = session.agent.split("::");
                  const harnessLabel =
                    harnesses.find((entry) => entry.id === harnessId)?.label ??
                    harnessId ??
                    "Harness";
                  const modelLabel = findPiModelOption(
                    provider as "openai" | "anthropic" | "gemini",
                    model ?? "",
                  )?.label;

                  return (
                    <Link
                      key={session.id}
                      to={`${basePath}/${encodeURIComponent(session.workflowName)}/${encodeURIComponent(session.id)}`}
                      preventScrollReset
                      aria-current={isSelected ? "page" : undefined}
                      className={
                        isSelected
                          ? "block w-full border border-[color:var(--bo-accent)] bg-[var(--bo-accent-bg)] px-3 py-3 text-left text-[var(--bo-accent-fg)]"
                          : "block w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-3 text-left text-[var(--bo-muted)] hover:border-[color:var(--bo-border-strong)]"
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-[var(--bo-fg)]">
                            {session.name || session.id}
                          </p>
                          <p className="text-xs text-[var(--bo-muted-2)]">
                            {harnessLabel} · {modelLabel ?? model}
                          </p>
                        </div>
                        <span className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[9px] tracking-[0.22em] uppercase">
                          {workflowStatus}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-[var(--bo-muted-2)]">
                        Updated {formatTimestamp(session.updatedAt)}
                      </p>
                    </Link>
                  );
                })
              )}
            </ScrollArea.Content>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar
            orientation="vertical"
            keepMounted
            className="flex w-2.5 p-[2px] select-none"
          >
            <ScrollArea.Thumb className="w-full rounded-full bg-[rgba(var(--bo-grid),0.45)] transition-colors hover:bg-[rgba(var(--bo-grid),0.65)]" />
          </ScrollArea.Scrollbar>
          <ScrollArea.Corner className="bg-transparent" />
        </ScrollArea.Root>
      </div>

      <div
        className={`${detailVisibility} flex min-h-0 flex-1 flex-col overflow-hidden border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4`}
      >
        <Outlet
          context={{
            scope,
            persistenceSource: source,
            harnesses,
            basePath,
            createSessionPanel,
          }}
        />
      </div>
    </section>
  );
}
