import type { Route } from "./+types/threads";

import { useFragno, useStore } from "@fragno-dev/core/react";
import {
  createAiFragmentClients,
  type AiArtifact,
  type AiMessage,
  type AiRun,
  type AiRunEvent,
  type AiThread,
} from "@fragno-dev/fragment-ai";
import { useEffect, useMemo, useState } from "react";

export function meta(_: Route.MetaArgs) {
  return [{ title: "AI Threads" }, { name: "description", content: "Explore AI fragment threads" }];
}

const aiClient = createAiFragmentClients({ mountRoute: "/api/ai" });
const aiHooks = useFragno(aiClient);
const { useCreateThread, useAppendMessage, useCreateRun, useRunStream } = aiHooks;

type FetcherState<TData> = {
  data?: TData;
  loading: boolean;
  error?: { message: string };
};

type ThreadsPayload = {
  threads: AiThread[];
  cursor?: string;
  hasNextPage: boolean;
};

type MessagesPayload = {
  messages: AiMessage[];
  cursor?: string;
  hasNextPage: boolean;
};

type RunsPayload = {
  runs: AiRun[];
  cursor?: string;
  hasNextPage: boolean;
};

type RunEventsPayload = {
  events: AiRunEvent[];
  cursor?: string;
  hasNextPage: boolean;
};

type ArtifactsPayload = {
  artifacts: AiArtifact[];
};

export default function Threads() {
  const threadsStore = useMemo(() => aiClient.useThreads.store(), []);
  const threadsState = useStore(threadsStore) as FetcherState<ThreadsPayload>;
  const threads = threadsState.data?.threads ?? [];
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    if (!threads.length) {
      setSelectedThreadId(null);
      return;
    }

    if (!selectedThreadId || !threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(threads[0]?.id ?? null);
    }
  }, [threads, selectedThreadId]);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  return (
    <section className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <div className="flex h-full flex-col gap-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">Threads</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Active threads</h1>
          <p className="mt-2 text-sm text-slate-500">
            Create a thread and jump into messages, runs, and streaming output.
          </p>
        </div>

        <CreateThreadPanel onCreated={(threadId) => setSelectedThreadId(threadId)} />

        <div className="space-y-3">
          {threadsState.loading && (
            <div className="rounded-xl border border-slate-200 p-3">Loading…</div>
          )}
          {threadsState.error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              Failed to load threads: {threadsState.error.message}
            </div>
          )}
          {!threadsState.loading && threads.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              No threads yet. Create one to get started.
            </div>
          )}
          {threads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              onClick={() => setSelectedThreadId(thread.id)}
              className={`w-full rounded-2xl border p-4 text-left transition ${
                thread.id === selectedThreadId
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-900 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{thread.title?.trim() || "Untitled thread"}</p>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] ${
                    thread.id === selectedThreadId
                      ? "bg-white/10 text-white"
                      : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {thread.defaultModelId}
                </span>
              </div>
              <p
                className={`mt-2 text-xs ${
                  thread.id === selectedThreadId ? "text-slate-200" : "text-slate-500"
                }`}
              >
                {thread.systemPrompt?.slice(0, 80) || "No system prompt"}
              </p>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {selectedThread && (
          <ThreadDetail
            key={selectedThread.id}
            threadId={selectedThread.id}
            thread={selectedThread}
          />
        )}
        {!selectedThread && (
          <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
            Select a thread on the left to view messages and runs.
          </div>
        )}
      </div>
    </section>
  );
}

function CreateThreadPanel({ onCreated }: { onCreated: (threadId: string) => void }) {
  const [title, setTitle] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const { mutate, loading, error } = useCreateThread();

  const handleCreate = async () => {
    const created = (await mutate({
      body: {
        title: title.trim() ? title.trim() : null,
        systemPrompt: systemPrompt.trim() ? systemPrompt.trim() : null,
      },
    })) as AiThread | undefined;
    if (!created) {
      return;
    }
    setTitle("");
    setSystemPrompt("");
    onCreated(created.id);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">New thread</p>
      <div className="mt-3 space-y-3">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Thread title"
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
        />
        <textarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          placeholder="System prompt (optional)"
          rows={3}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={loading}
          className="w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Creating…" : "Create thread"}
        </button>
        {error && <p className="text-xs text-rose-600">{error.message}</p>}
      </div>
    </div>
  );
}

function ThreadDetail({
  threadId,
  thread,
}: {
  threadId: string;
  thread: {
    id: string;
    title: string | null;
    systemPrompt: string | null;
    defaultModelId: string;
    defaultThinkingLevel: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
}) {
  const messagesStore = useMemo(
    () =>
      aiClient.useMessages.store({
        path: { threadId },
        query: { order: "asc", pageSize: "50", cursor: undefined },
      }),
    [threadId],
  );
  const messagesState = useStore(messagesStore) as FetcherState<MessagesPayload>;
  const runsStore = useMemo(
    () =>
      aiClient.useRuns.store({
        path: { threadId },
        query: { order: "desc", pageSize: "50", cursor: undefined },
      }),
    [threadId],
  );
  const runsState = useStore(runsStore) as FetcherState<RunsPayload>;
  const { mutate: appendMessage, loading: appendLoading, error: appendError } = useAppendMessage();
  const { mutate: createRun, loading: runLoading, error: runError } = useCreateRun();
  const { text, status, error: streamError, startRunStream } = useRunStream();

  const [messageText, setMessageText] = useState("");
  const [runType, setRunType] = useState<"agent" | "deep_research">("agent");
  const [runMode, setRunMode] = useState<"background" | "stream">("background");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runs = runsState.data?.runs ?? [];
  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  useEffect(() => {
    const interval = setInterval(() => {
      messagesStore.revalidate();
      runsStore.revalidate();
    }, 1000);

    return () => clearInterval(interval);
  }, [messagesStore, runsStore]);

  useEffect(() => {
    if (!runs.length) {
      setSelectedRunId(null);
      return;
    }

    if (!selectedRunId || !runs.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(runs[0]?.id ?? null);
    }
  }, [runs, selectedRunId]);

  const handleAppend = async () => {
    const trimmed = messageText.trim();
    if (!trimmed) {
      return;
    }
    await appendMessage({
      path: { threadId },
      body: {
        role: "user",
        content: { type: "text", text: trimmed },
        text: trimmed,
      },
    });
    setMessageText("");
  };

  const handleCreateRun = async () => {
    if (runMode === "stream") {
      await startRunStream({
        threadId,
        input: {
          type: runType,
        },
      });
      return;
    }

    await createRun({
      path: { threadId },
      body: {
        type: runType,
        executionMode: "background",
      },
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">
              Thread detail
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">
              {thread.title?.trim() || "Untitled thread"}
            </h2>
            <p className="mt-2 text-sm text-slate-500">ID: {thread.id}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <p>Model: {thread.defaultModelId}</p>
            <p>Thinking: {thread.defaultThinkingLevel}</p>
          </div>
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
              System prompt
            </p>
            <p className="mt-3 whitespace-pre-wrap">
              {thread.systemPrompt || "No system prompt set."}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
              Timestamps
            </p>
            <p className="mt-3">Created: {formatTimestamp(thread.createdAt)}</p>
            <p className="mt-1">Updated: {formatTimestamp(thread.updatedAt)}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">Messages</h3>
            <span className="text-xs uppercase tracking-[0.3em] text-slate-400">
              {messagesState.data?.messages?.length ?? 0}
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {messagesState.loading && (
              <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-500">
                Loading messages…
              </div>
            )}
            {messagesState.error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                Failed to load messages: {messagesState.error.message}
              </div>
            )}
            {!messagesState.loading && (messagesState.data?.messages?.length ?? 0) === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
                No messages yet. Append one to start a run.
              </div>
            )}
            {messagesState.data?.messages?.map((message) => (
              <div
                key={message.id}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm"
              >
                <div className="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-slate-400">
                  <span>{message.role}</span>
                  <span>{formatTimestamp(message.createdAt)}</span>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-slate-700">
                  {renderMessageContent(message)}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
              Append message
            </p>
            <textarea
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              rows={3}
              placeholder="Write a user message"
              className="mt-3 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
            />
            <button
              type="button"
              onClick={handleAppend}
              disabled={appendLoading || !messageText.trim()}
              className="mt-3 w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {appendLoading ? "Appending…" : "Append message"}
            </button>
            {appendError && <p className="mt-2 text-xs text-rose-600">{appendError.message}</p>}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">Runs</h3>
            <span className="text-xs uppercase tracking-[0.3em] text-slate-400">
              {runsState.data?.runs?.length ?? 0}
            </span>
          </div>

          <div className="mt-4 space-y-3">
            {runsState.loading && (
              <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-500">
                Loading runs…
              </div>
            )}
            {runsState.error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                Failed to load runs: {runsState.error.message}
              </div>
            )}
            {!runsState.loading && (runsState.data?.runs?.length ?? 0) === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
                No runs yet. Create one to process the latest user message.
              </div>
            )}
            {runsState.data?.runs?.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={`w-full rounded-2xl border p-4 text-left text-sm transition ${
                  run.id === selectedRunId
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-900 hover:border-slate-300"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span
                    className={`rounded-full px-2 py-1 uppercase tracking-[0.2em] ${
                      run.id === selectedRunId
                        ? "bg-white/10 text-white"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {run.type}
                  </span>
                  <span
                    className={`rounded-full px-2 py-1 uppercase tracking-[0.2em] ${
                      run.id === selectedRunId
                        ? "bg-white/20 text-white"
                        : "bg-slate-900 text-white"
                    }`}
                  >
                    {run.status}
                  </span>
                </div>
                <div
                  className={`mt-3 space-y-1 text-xs ${
                    run.id === selectedRunId ? "text-slate-200" : "text-slate-500"
                  }`}
                >
                  <p>Model: {run.modelId}</p>
                  <p>Execution: {run.executionMode}</p>
                  <p>Started: {formatTimestamp(run.startedAt)}</p>
                  <p>Completed: {formatTimestamp(run.completedAt)}</p>
                </div>
                {run.error && (
                  <p
                    className={`mt-2 text-xs ${
                      run.id === selectedRunId ? "text-rose-300" : "text-rose-600"
                    }`}
                  >
                    {run.error}
                  </p>
                )}
              </button>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
              Create run
            </p>
            <div className="mt-3 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
              <label className="flex flex-col gap-2">
                <span className="text-xs uppercase tracking-[0.25em] text-slate-400">Type</span>
                <select
                  value={runType}
                  onChange={(event) =>
                    setRunType(event.target.value === "deep_research" ? "deep_research" : "agent")
                  }
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="agent">agent</option>
                  <option value="deep_research">deep_research</option>
                </select>
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-xs uppercase tracking-[0.25em] text-slate-400">Mode</span>
                <select
                  value={runMode}
                  onChange={(event) =>
                    setRunMode(event.target.value === "stream" ? "stream" : "background")
                  }
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                >
                  <option value="background">background</option>
                  <option value="stream">stream</option>
                </select>
              </label>
            </div>
            <button
              type="button"
              onClick={handleCreateRun}
              disabled={runLoading || (runMode === "stream" && runType === "deep_research")}
              className="mt-3 w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {runMode === "stream" ? "Start stream run" : "Queue background run"}
            </button>
            {runMode === "stream" && runType === "deep_research" && (
              <p className="mt-2 text-xs text-amber-600">
                Deep research runs must execute in the background.
              </p>
            )}
            {runError && <p className="mt-2 text-xs text-rose-600">{runError.message}</p>}
          </div>

          <div className="mt-6 rounded-2xl border border-slate-900 bg-slate-900 p-4 text-slate-100">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-slate-400">
              <span>Stream output</span>
              <span>{status?.status ?? "idle"}</span>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-100">
              {text || "Stream output will appear here."}
            </p>
            {streamError && (
              <p className="mt-2 text-xs text-rose-300">Stream error: {streamError.message}</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        {selectedRun ? (
          <RunDetailPanel run={selectedRun} />
        ) : (
          <div className="rounded-3xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm lg:col-span-2">
            Select a run to inspect events and artifacts.
          </div>
        )}
      </div>
    </div>
  );
}

function RunDetailPanel({
  run,
}: {
  run: {
    id: string;
    status: string;
    executionMode: string;
    modelId: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
}) {
  const runEventsStore = useMemo(
    () =>
      aiClient.useRunEvents.store({
        path: { runId: run.id },
        query: { order: "asc", pageSize: "100", cursor: undefined },
      }),
    [run.id],
  );
  const runEventsState = useStore(runEventsStore) as FetcherState<RunEventsPayload>;
  const artifactsStore = useMemo(
    () => aiClient.useArtifacts.store({ path: { runId: run.id } }),
    [run.id],
  );
  const artifactsState = useStore(artifactsStore) as FetcherState<ArtifactsPayload>;

  useEffect(() => {
    if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
      return;
    }

    const interval = setInterval(() => {
      runEventsStore.revalidate();
      artifactsStore.revalidate();
    }, 1000);

    return () => clearInterval(interval);
  }, [artifactsStore, run.status, runEventsStore]);

  const events = runEventsState.data?.events ?? [];
  const artifacts = artifactsState.data?.artifacts ?? [];

  return (
    <>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">Run events</h3>
          <span className="text-xs uppercase tracking-[0.3em] text-slate-400">{events.length}</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">Run ID: {run.id}</p>
        <div className="mt-4 space-y-3">
          {runEventsState.loading && (
            <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-500">
              Loading events…
            </div>
          )}
          {runEventsState.error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              Failed to load events: {runEventsState.error.message}
            </div>
          )}
          {!runEventsState.loading && events.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              No persisted events for this run yet.
            </div>
          )}
          {events.map((event) => (
            <div
              key={`${event.runId}-${event.seq}`}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600"
            >
              <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-slate-400">
                <span>{event.type}</span>
                <span>{formatTimestamp(event.createdAt)}</span>
              </div>
              {event.payload != null ? (
                <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-white/70 p-3 text-xs text-slate-700">
                  {formatPayload(event.payload)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">Artifacts</h3>
          <span className="text-xs uppercase tracking-[0.3em] text-slate-400">
            {artifacts.length}
          </span>
        </div>
        <div className="mt-4 space-y-4">
          {artifactsState.loading && (
            <div className="rounded-xl border border-slate-200 p-3 text-sm text-slate-500">
              Loading artifacts…
            </div>
          )}
          {artifactsState.error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
              Failed to load artifacts: {artifactsState.error.message}
            </div>
          )}
          {!artifactsState.loading && artifacts.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              No artifacts for this run yet.
            </div>
          )}
          {artifacts.map((artifact) => (
            <div
              key={artifact.id}
              className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600"
            >
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.25em] text-slate-400">
                <span>{artifact.type}</span>
                <span>{formatTimestamp(artifact.createdAt)}</span>
              </div>
              <p className="mt-2 text-sm font-semibold text-slate-800">
                {artifact.title ?? "Untitled artifact"}
              </p>
              <p className="mt-1 text-xs text-slate-500">{artifact.mimeType}</p>
              <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-white/80 p-3 text-xs text-slate-700">
                {resolveArtifactText(artifact)}
              </pre>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function renderMessageContent(message: { text: string | null; content: unknown }) {
  if (message.text) {
    return message.text;
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (message.content && typeof message.content === "object" && "text" in message.content) {
    const text = (message.content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }

  try {
    return JSON.stringify(message.content, null, 2);
  } catch {
    return "Unsupported message content.";
  }
}

function formatPayload(payload: unknown) {
  if (typeof payload === "string") {
    return payload;
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "Unsupported event payload.";
  }
}

function resolveArtifactText(artifact: { text: string | null; data: unknown }) {
  if (artifact.text) {
    return artifact.text;
  }

  if (artifact.data && typeof artifact.data === "object" && "reportMarkdown" in artifact.data) {
    const text = (artifact.data as { reportMarkdown?: unknown }).reportMarkdown;
    if (typeof text === "string") {
      return text;
    }
  }

  return formatPayload(artifact.data);
}

function formatTimestamp(value: string | Date | null | undefined) {
  if (!value) {
    return "—";
  }
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleString();
}
