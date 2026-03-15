import { ScrollArea } from "@base-ui/react/scroll-area";
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

import type { PiSession, PiSessionStatus } from "@fragno-dev/pi-fragment";

import { getAuthMe } from "@/fragno/auth-server";
import {
  createPiAgentName,
  findPiModelOption,
  PI_MODEL_CATALOG,
  resolvePiHarnesses,
  type PiHarnessConfig,
} from "@/fragno/pi-shared";

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
  summaries: Record<string, string | null>;
};

type PiCreateSessionActionData = {
  intent: "create-session";
  ok: boolean;
  message?: string;
};

export type PiSendMessageActionData = {
  intent: "send-message";
  ok: boolean;
  message?: string;
  status?: PiSessionStatus | null;
};

type PiSessionsActionData = PiCreateSessionActionData | PiSendMessageActionData;

export type PiSessionsOutletContext = {
  sessions: PiSession[];
  summaries: Record<string, string | null>;
  harnesses: PiHarnessConfig[];
  selectedSessionId: string | null;
  basePath: string;
  createSessionPanel?: ReactNode;
};

const parseTags = (value: string) =>
  value
    .split(/[,\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean);

const parseOptionalBoolean = (value: FormDataEntryValue | null) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
};

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!params.orgId) {
    throw new Response("Not Found", { status: 404 });
  }

  const emptySummaries: Record<string, string | null> = {};

  const { configState, configError } = await fetchPiConfig(context, params.orgId);
  if (configError) {
    return {
      configError,
      sessionsError: null,
      sessions: [],
      summaries: emptySummaries,
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
      summaries: emptySummaries,
    } satisfies PiSessionsLoaderData;
  }

  const summaries: Record<string, string | null> = {};
  const detailResults = await Promise.all(
    sessions.map((session) =>
      fetchPiSessionDetail(request, context, params.orgId!, session.id).catch(() => null),
    ),
  );

  detailResults.forEach((result, index) => {
    const session = sessions[index];
    if (!session) {
      return;
    }
    const summary = result?.session?.summaries?.at(-1)?.summary ?? null;
    summaries[session.id] = summary;
  });

  return {
    configError: null,
    sessionsError: null,
    sessions,
    summaries,
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
    const steeringMode = getValue("steeringMode");
    const done = parseOptionalBoolean(formData.get("done"));

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

    if (steeringMode && steeringMode !== "all" && steeringMode !== "one-at-a-time") {
      return {
        intent: "send-message",
        ok: false,
        message: "Steering mode must be all or one-at-a-time.",
      } satisfies PiSendMessageActionData;
    }

    const result = await sendPiSessionMessage(request, context, params.orgId, sessionId, {
      text,
      done,
      steeringMode:
        steeringMode === "all" || steeringMode === "one-at-a-time" ? steeringMode : undefined,
    });

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
  const steeringMode = getValue("steeringMode") as "all" | "one-at-a-time";
  const tagsRaw = getValue("tags");
  const metadataRaw = getValue("metadata");

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

  if (steeringMode !== "all" && steeringMode !== "one-at-a-time") {
    return {
      intent: "create-session",
      ok: false,
      message: "Steering mode must be all or one-at-a-time.",
    } satisfies PiCreateSessionActionData;
  }

  let metadata: unknown | undefined;
  if (metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw);
    } catch {
      return {
        intent: "create-session",
        ok: false,
        message: "Metadata must be valid JSON.",
      } satisfies PiCreateSessionActionData;
    }
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

  const tags = tagsRaw ? parseTags(tagsRaw) : undefined;

  const result = await createPiSession(request, context, params.orgId, {
    agent,
    name: name || undefined,
    steeringMode,
    tags,
    metadata,
  });

  if (result.error || !result.session) {
    return {
      intent: "create-session",
      ok: false,
      message: result.error ?? "Failed to create session.",
    } satisfies PiCreateSessionActionData;
  }

  return redirect(`/backoffice/sessions/${params.orgId}/sessions/${result.session.id}`);
}

export default function BackofficeOrganisationPiSessionsLayout() {
  const { sessions, configError, sessionsError, summaries } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as PiSessionsActionData | undefined;
  const navigation = useNavigation();
  const { orgId, configState } = useOutletContext<PiLayoutContext>();
  const { sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const selectedSessionId = sessionId ?? null;
  const isNewSession = searchParams.get("new") === "1";
  const basePath = `/backoffice/sessions/${orgId}/sessions`;
  const isDetailRoute = Boolean(selectedSessionId);
  const activeIntent = navigation.formData?.get("intent");
  const creating = navigation.state === "submitting" && activeIntent === "create-session";
  const harnesses = resolvePiHarnesses(configState?.config?.harnesses);
  const [selectedHarnessId, setSelectedHarnessId] = useState(harnesses[0]?.id ?? "");
  const [selectedModelOption, setSelectedModelOption] = useState(
    PI_MODEL_CATALOG[0] ? `${PI_MODEL_CATALOG[0].provider}::${PI_MODEL_CATALOG[0].name}` : "",
  );
  const [steeringMode, setSteeringMode] = useState<"all" | "one-at-a-time">(
    harnesses[0]?.steeringMode ?? "one-at-a-time",
  );

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
    const harness = harnesses.find((entry) => entry.id === selectedHarnessId);
    if (harness?.steeringMode) {
      setSteeringMode(harness.steeringMode);
    }
  }, [harnesses, selectedHarnessId]);

  const selectedHarness = useMemo(
    () => harnesses.find((entry) => entry.id === selectedHarnessId) ?? null,
    [harnesses, selectedHarnessId],
  );

  if (configError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">{configError}</div>
    );
  }

  if (sessionsError) {
    return (
      <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-600">
        {sessionsError}
      </div>
    );
  }

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
            <select
              name="modelOption"
              required
              value={selectedModelOption}
              onChange={(event) => setSelectedModelOption(event.target.value)}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            >
              {PI_MODEL_CATALOG.map((option) => (
                <option
                  key={`${option.provider}-${option.name}`}
                  value={`${option.provider}::${option.name}`}
                >
                  {option.label}
                </option>
              ))}
            </select>
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

          <div className="space-y-2">
            <label className="text-xs font-semibold text-[var(--bo-fg)]">Steering mode</label>
            <select
              name="steeringMode"
              required
              value={steeringMode}
              onChange={(event) => setSteeringMode(event.target.value as "all" | "one-at-a-time")}
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            >
              <option value="one-at-a-time">One-at-a-time</option>
              <option value="all">All</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-[var(--bo-fg)]">Tags</label>
            <input
              type="text"
              name="tags"
              placeholder="Comma-separated tags"
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold text-[var(--bo-fg)]">Metadata (JSON)</label>
            <textarea
              name="metadata"
              rows={3}
              placeholder='{"source": "backoffice"}'
              className="w-full border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-3 py-2 text-sm text-[var(--bo-fg)]"
            />
          </div>

          <button
            type="submit"
            disabled={creating}
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

        <ScrollArea.Root className="relative mt-3 flex min-h-0 flex-1 overflow-hidden">
          <ScrollArea.Viewport className="min-h-0 flex-1 pr-1">
            <ScrollArea.Content className="space-y-2">
              {sessions.length === 0 ? (
                <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-4 text-sm text-[var(--bo-muted)]">
                  No sessions yet. Use the new session button above to get started.
                </div>
              ) : (
                sessions.map((session) => {
                  const summary = summaries[session.id];
                  const isSelected = session.id === selectedSessionId;
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
                      to={`${basePath}/${session.id}`}
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
                          {session.status}
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
        className={`${detailVisibility} flex min-h-0 flex-1 flex-col border border-[color:var(--bo-border)] bg-[var(--bo-panel)]`}
      >
        <ScrollArea.Root className="relative flex min-h-0 flex-1 overflow-hidden">
          <ScrollArea.Viewport className="min-h-0 flex-1 p-4">
            <ScrollArea.Content className="flex min-h-full flex-col">
              <Outlet
                context={{
                  sessions,
                  summaries,
                  harnesses,
                  selectedSessionId,
                  basePath,
                  createSessionPanel,
                }}
              />
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
    </section>
  );
}
