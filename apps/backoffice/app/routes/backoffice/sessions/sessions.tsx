import { ScrollArea } from "@base-ui/react/scroll-area";
import { useStore } from "@fragno-dev/core/react";
import type { PiSession, PiWorkflowStatus } from "@fragno-dev/pi-harness/types";
import { INTERACTIVE_CHAT_WORKFLOW_NAME } from "@fragno-dev/pi-harness/workflows/interactive-chat-workflow";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Form,
  Link,
  Outlet,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router";

import { getAuthMe } from "@/fragno/auth/auth-server";
import { createPiLofiSessionListingStore } from "@/fragno/pi/pi-client";
import {
  createPiAgentName,
  findPiModelOption,
  PI_MODEL_CATALOG,
  resolvePiHarnesses,
  type PiHarnessConfig,
} from "@/fragno/pi/pi-shared";

import type { Route } from "./+types/sessions";
import {
  createPiSession,
  fetchPiConfig,
  fetchPiSessionDetail,
  fetchPiSessions,
  sendPiSessionMessage,
} from "./data";
import type { PiLayoutContext } from "./shared";
import { formatTimestamp } from "./shared";

type PiSessionsLoaderData = {
  configError: string | null;
  sessionsError: string | null;
  sessions: PiSession[];
  turnSummaries: Record<string, string | null>;
  workflowStatuses: Record<string, PiWorkflowStatus | null>;
};

type PiCreateSessionActionData = {
  intent: "create-session";
  ok: boolean;
  message?: string;
};

type PiSendMessageActionData = {
  intent: "send-message";
  ok: boolean;
  message?: string;
  status?: PiWorkflowStatus | null;
};

type PiSessionsActionData = PiCreateSessionActionData | PiSendMessageActionData;

export type PiSessionsOutletContext = {
  sessions: PiSession[];
  turnSummaries: Record<string, string | null>;
  workflowStatuses: Record<string, PiWorkflowStatus | null>;
  harnesses: PiHarnessConfig[];
  selectedSessionId: string | null;
  basePath: string;
  createSessionPanel?: ReactNode;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const emptyTurnSummaries: Record<string, string | null> = {};
  const emptyWorkflowStatuses: Record<string, PiWorkflowStatus | null> = {};

  const { configState, configError } = await fetchPiConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      sessionsError: null,
      sessions: [],
      turnSummaries: emptyTurnSummaries,
      workflowStatuses: emptyWorkflowStatuses,
    } satisfies PiSessionsLoaderData;
  }

  if (!configState?.configured) {
    return redirect(`/backoffice/sessions/${params.orgId}/configuration`);
  }

  const { sessions, sessionsError } = await fetchPiSessions(request, context, params.orgId);
  if (sessionsError) {
    return {
      configError: null,
      sessionsError,
      sessions: [],
      turnSummaries: emptyTurnSummaries,
      workflowStatuses: emptyWorkflowStatuses,
    } satisfies PiSessionsLoaderData;
  }

  const turnSummaries: Record<string, string | null> = {};
  const workflowStatuses: Record<string, PiWorkflowStatus | null> = {};
  const detailResults = await Promise.all(
    sessions.map((session) =>
      fetchPiSessionDetail(request, context, params.orgId!, session.workflowName, session.id),
    ),
  );
  const failedDetail = detailResults.find((result) => result.sessionError);
  if (failedDetail?.sessionError) {
    return {
      configError: null,
      sessionsError: failedDetail.sessionError.message,
      sessions: [],
      turnSummaries: emptyTurnSummaries,
      workflowStatuses: emptyWorkflowStatuses,
    } satisfies PiSessionsLoaderData;
  }

  detailResults.forEach((result, index) => {
    const session = sessions[index];
    if (!session) {
      return;
    }
    workflowStatuses[session.id] = result?.session?.workflow.status ?? null;
    const messages = result?.session?.agent.state.messages ?? [];
    const assistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");
    turnSummaries[session.id] = assistantMessage ? "Last assistant response available" : null;
  });

  return {
    configError: null,
    sessionsError: null,
    sessions,
    turnSummaries,
    workflowStatuses,
  } satisfies PiSessionsLoaderData;
}

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

  const formData = await request.formData();
  const getValue = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };
  const intent = getValue("intent") || "create-session";

  if (intent === "send-message") {
    const sessionId = getValue("sessionId");
    const text = getValue("text");
    const commandKind = getValue("commandKind");
    if (!sessionId) {
      return {
        intent: "send-message",
        ok: false,
        message: "Session ID is required.",
      } satisfies PiSendMessageActionData;
    }

    if (!text) {
      return {
        intent: "send-message",
        ok: false,
        message: "Message text is required.",
      } satisfies PiSendMessageActionData;
    }

    if (commandKind && commandKind !== "followUp" && commandKind !== "steer") {
      return {
        intent: "send-message",
        ok: false,
        message: "Command kind must be followUp or steer.",
      } satisfies PiSendMessageActionData;
    }

    const workflowName = getValue("workflowName");
    if (!workflowName) {
      return {
        intent: "send-message",
        ok: false,
        message: "Workflow name is required.",
      } satisfies PiSendMessageActionData;
    }

    const result = await sendPiSessionMessage(
      request,
      context,
      params.orgId,
      workflowName,
      sessionId,
      {
        text,
        commandKind:
          commandKind === "followUp" || commandKind === "steer" ? commandKind : undefined,
      },
    );

    return {
      intent: "send-message",
      ok: !result.error && result.status !== null,
      message: result.error ?? undefined,
      status: result.status,
    } satisfies PiSendMessageActionData;
  }

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

  const { configState, configError } = await fetchPiConfig(context, params.orgId);
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

  const result = await createPiSession(request, context, params.orgId, {
    workflowName: INTERACTIVE_CHAT_WORKFLOW_NAME,
    input: {
      harnessName: agent,
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
  const {
    sessions: serverSessions,
    configError,
    sessionsError,
    turnSummaries: serverTurnSummaries,
    workflowStatuses: serverWorkflowStatuses,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as PiSessionsActionData | undefined;
  const navigation = useNavigation();
  const { orgId, configState } = useOutletContext<PiLayoutContext>();
  const { sessionId, workflowName } = useParams();
  const [searchParams] = useSearchParams();
  const selectedWorkflowName = workflowName ?? null;
  const selectedSessionId = sessionId ?? null;
  const isNewSession = searchParams.get("new") === "1";
  const basePath = `/backoffice/sessions/${orgId}/sessions`;
  const isDetailRoute = Boolean(selectedSessionId);
  const lofiSessionListingStore = useMemo(
    () =>
      createPiLofiSessionListingStore(orgId, INTERACTIVE_CHAT_WORKFLOW_NAME, {
        initialData: {
          sessions: serverSessions,
          workflowStatuses: serverWorkflowStatuses,
        },
      }),
    [orgId, serverSessions, serverWorkflowStatuses],
  );
  const lofiSessionListing = useStore(lofiSessionListingStore);
  const { sessions, workflowStatuses } = lofiSessionListing.data;
  const turnSummaries = serverTurnSummaries;
  const lofiSessionListingError =
    lofiSessionListing.error instanceof Error
      ? lofiSessionListing.error.message
      : lofiSessionListing.error
        ? "Pi session listing sync failed."
        : null;
  const activeIntent = navigation.formData?.get("intent");
  const creating = navigation.state === "submitting" && activeIntent === "create-session";
  const harnesses = resolvePiHarnesses(configState?.config?.harnesses);
  const [selectedHarnessId, setSelectedHarnessId] = useState(harnesses[0]?.id ?? "");
  const availableModelOptions = useMemo(() => {
    const apiKeys = configState?.config?.apiKeys;
    return PI_MODEL_CATALOG.filter((option) => Boolean(apiKeys?.[option.provider]));
  }, [
    configState?.config?.apiKeys?.gemini,
    configState?.config?.apiKeys?.anthropic,
    configState?.config?.apiKeys?.openai,
  ]);
  const [selectedModelOption, setSelectedModelOption] = useState("");
  useEffect(() => {
    if (harnesses.length === 0) {
      setSelectedHarnessId("");
      return;
    }
    if (!harnesses.some((harness) => harness.id === selectedHarnessId)) {
      setSelectedHarnessId(harnesses[0].id);
    }
  }, [harnesses, selectedHarnessId]);

  useEffect(() => {
    const nextModel =
      selectedModelOption &&
      availableModelOptions.some(
        (option) => `${option.provider}::${option.name}` === selectedModelOption,
      )
        ? selectedModelOption
        : availableModelOptions[0]
          ? `${availableModelOptions[0].provider}::${availableModelOptions[0].name}`
          : "";
    if (nextModel !== selectedModelOption) {
      setSelectedModelOption(nextModel);
    }
  }, [availableModelOptions, selectedModelOption]);

  const selectedHarness = useMemo(
    () => harnesses.find((entry) => entry.id === selectedHarnessId) ?? null,
    [harnesses, selectedHarnessId],
  );

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  const sessionListingServerError = sessionsError?.trim() || null;
  const sessionListingBlockingError =
    sessionListingServerError && sessions.length === 0 ? sessionListingServerError : null;

  const isDetailView = isDetailRoute || isNewSession;
  // Use flex for both; max-lg:hidden only applies below lg so lg layout stays stable
  const listVisibility = isDetailView ? "max-lg:hidden lg:flex" : "flex";
  const detailVisibility = "block";
  const createError =
    actionData?.intent === "create-session" && actionData.ok === false ? actionData.message : null;
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
              onChange={(event) => setSelectedHarnessId(event.target.value)}
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
                      onClick={() => setSelectedModelOption(value)}
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
            <label className="text-xs font-semibold text-[var(--bo-fg)]">Session name</label>
            <input
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

        {sessionListingServerError ? (
          <div className="border border-amber-300/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
            {sessionListingBlockingError ?? "Server refresh failed; showing local session data."}
          </div>
        ) : null}

        {lofiSessionListingError ? (
          <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            {lofiSessionListingError}
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
                  const summary = turnSummaries[session.id];
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
                      <p className="mt-2 text-xs text-[var(--bo-muted)]">
                        {summary ? summary.slice(0, 140) : "No summary yet."}
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
            sessions,
            turnSummaries,
            workflowStatuses,
            harnesses,
            selectedSessionId,
            basePath,
            createSessionPanel,
          }}
        />
      </div>
    </section>
  );
}
