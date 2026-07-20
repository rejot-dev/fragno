/*
 * Client-only hook that drives a manual workflow run and surfaces realtime
 * progress for the pipeline graph. Given the instance id returned by the `run`
 * action, it:
 *   - streams step emissions (NDJSON) from the Automations DO for a live feed, and
 *   - polls the instance history + status until the run reaches a terminal state.
 * It correlates runtime steps back to the static graph's step nodes so the graph
 * can highlight what is running / done / errored.
 *
 * No server imports — this runs in the browser. The endpoints are reached through
 * the `/api/automations-workflows/:orgId/*` catch-all (forwarded to the Automations
 * Durable Object's *workflows* fragment, where `pi-codemode-script` is registered).
 * Note the `-workflows` mount: the bare `/api/automations/:orgId/*` catch-all targets
 * the automation fragment, which does not expose workflow instance endpoints.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GraphNode, WorkflowGraph } from "@fragno-dev/workflow-visualizer";

/** Mirrors the workflows fragment instance statuses, plus local pre-run states. */
export type RunStatus =
  | "idle"
  | "starting"
  | "active"
  | "waiting"
  | "paused"
  | "complete"
  | "errored"
  | "terminated";

const TERMINAL: ReadonlySet<RunStatus> = new Set(["complete", "errored", "terminated"]);

export type NodeRunState = {
  status: string;
  attempts: number;
  error?: string;
  emissionCount: number;
};

export type RunEmission = {
  id: string;
  stepKey: string;
  epoch: string;
  sequence: number;
  payload: unknown;
  createdAt: string;
};

/**
 * One step execution from the instance history — the same shape the backoffice
 * automations detail view renders, so a codemode run can show a step-by-step
 * execution list alongside the graph.
 */
export type RunStep = {
  id: string;
  stepKey: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  error?: { name: string; message: string };
  createdAt: string;
  updatedAt: string;
};

type HistoryStep = RunStep;

// Poll cadence matches the screen's existing "Go live" interval; the emission
// stream is push-based, but the server closes it after ~60s so we reconnect
// while the run is still going.
const POLL_INTERVAL_MS = 3500;
const RUN_MAX_MS = 10 * 60 * 1000;

export type WorkflowRun = {
  status: RunStatus;
  /** node id -> live run state, for graph highlighting. */
  stepStatesByNodeId: Map<string, NodeRunState>;
  /** The step executions so far, oldest first — for a step-by-step run list. */
  steps: RunStep[];
  emissions: RunEmission[];
  /** The run's final output, once it produces one (undefined until then). */
  output: unknown;
  error: string | null;
  instanceId: string | null;
  run: (instanceId: string) => void;
  reset: () => void;
};

export function useWorkflowRun({
  orgId,
  graph,
  runWorkflowName,
}: {
  orgId: string | null;
  graph: WorkflowGraph;
  runWorkflowName: string;
}): WorkflowRun {
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [steps, setSteps] = useState<HistoryStep[]>([]);
  const [emissions, setEmissions] = useState<RunEmission[]>([]);
  const [output, setOutput] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  // `${type}:${name}` -> graph step node ids, ordered by source `order`. Used to
  // map a runtime step (which carries name + type) back to its graph node.
  const nodesByTypeName = useMemo(() => buildNodesByTypeName(graph), [graph]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    setInstanceId(null);
    setStatus("idle");
    setSteps([]);
    setEmissions([]);
    setOutput(undefined);
    setError(null);
  }, [stop]);

  const run = useCallback(
    (id: string) => {
      stop();
      setInstanceId(id);
      setStatus("starting");
      setSteps([]);
      setEmissions([]);
      setOutput(undefined);
      setError(null);
      startedAtRef.current = Date.now();
    },
    [stop],
  );

  useEffect(() => {
    if (!instanceId || !orgId) {
      return undefined;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const base = `/api/automations-workflows/${encodeURIComponent(orgId)}/${encodeURIComponent(
      runWorkflowName,
    )}/instances/${encodeURIComponent(instanceId)}`;

    let stopped = false;
    const isTerminal = (s: RunStatus) => TERMINAL.has(s);

    const finish = () => {
      stopped = true;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      controller.abort();
    };

    // --- History + status polling -------------------------------------------
    const poll = async () => {
      try {
        const [historyRes, statusRes] = await Promise.all([
          fetch(`${base}/history`, { signal, headers: { accept: "application/json" } }),
          fetch(base, { signal, headers: { accept: "application/json" } }),
        ]);

        if (historyRes.ok) {
          const history = (await historyRes.json()) as { steps?: HistoryStep[] };
          if (Array.isArray(history.steps)) {
            setSteps(history.steps);
          }
        }

        if (statusRes.ok) {
          const body = (await statusRes.json()) as {
            details?: { status?: string; error?: { message?: string }; output?: unknown };
          };
          if (body.details && "output" in body.details) {
            setOutput(body.details.output);
          }
          const next = (body.details?.status as RunStatus | undefined) ?? "active";
          setStatus(next);
          if (next === "errored" && body.details?.error?.message) {
            setError(body.details.error.message);
          }
          if (isTerminal(next)) {
            finish();
            return;
          }
        }

        if (Date.now() - startedAtRef.current > RUN_MAX_MS) {
          finish();
        }
      } catch (err) {
        if (!signal.aborted) {
          // Transient poll failures are non-fatal; the next tick retries.
          console.warn("workflow run poll failed", err);
        }
      }
    };

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    // --- Emission stream (NDJSON), reconnecting while non-terminal -----------
    const streamLoop = async () => {
      while (!stopped && !signal.aborted) {
        try {
          const res = await fetch(`${base}/current-step/emissions?once=false`, { signal });
          if (!res.ok || !res.body) {
            break;
          }
          for await (const emission of readNdjson<RunEmission>(res.body, signal)) {
            setEmissions((prev) => mergeEmission(prev, emission));
          }
        } catch (err) {
          if (signal.aborted) {
            return;
          }
          console.warn("workflow run emission stream failed", err);
        }
        // Stream ended (server timeout) — pause briefly, then reconnect if the
        // run is still in flight. Snapshot replay on reconnect backfills frames.
        if (stopped || signal.aborted) {
          return;
        }
        await delay(750, signal);
      }
    };
    void streamLoop();

    return () => {
      stopped = true;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      controller.abort();
    };
  }, [instanceId, orgId, runWorkflowName]);

  // Stop everything on unmount.
  useEffect(() => stop, [stop]);

  // Correlate runtime steps + emissions onto graph node ids.
  const stepStatesByNodeId = useMemo(() => {
    const out = new Map<string, NodeRunState>();
    const nodeIdByStepKey = new Map<string, string>();
    const occurrence = new Map<string, number>();

    const ordered = [...steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const step of ordered) {
      const key = `${step.type}:${step.name}`;
      const candidates = nodesByTypeName.get(key);
      if (!candidates || candidates.length === 0) {
        continue; // dynamic / nested step with no static node — log-only.
      }
      const index = occurrence.get(key) ?? 0;
      occurrence.set(key, index + 1);
      const nodeId = candidates[Math.min(index, candidates.length - 1)];
      nodeIdByStepKey.set(step.stepKey, nodeId);
      out.set(nodeId, {
        status: step.status,
        attempts: step.attempts,
        error: step.error?.message,
        emissionCount: 0,
      });
    }

    for (const emission of emissions) {
      const nodeId = nodeIdByStepKey.get(emission.stepKey);
      if (!nodeId) {
        continue;
      }
      const existing = out.get(nodeId);
      if (existing) {
        existing.emissionCount += 1;
      }
    }

    return out;
  }, [steps, emissions, nodesByTypeName]);

  // Step executions, oldest first — the order they ran, for the run list.
  const orderedSteps = useMemo(
    () => [...steps].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [steps],
  );

  return {
    status,
    stepStatesByNodeId,
    steps: orderedSteps,
    emissions,
    output,
    error,
    instanceId,
    run,
    reset,
  };
}

function buildNodesByTypeName(graph: WorkflowGraph): Map<string, string[]> {
  const steps = graph.nodes.filter(
    (n): n is Extract<GraphNode, { kind: "step" }> => n.kind === "step",
  );
  steps.sort((a, b) => a.order - b.order);
  const map = new Map<string, string[]>();
  for (const step of steps) {
    const key = `${step.stepType}:${step.label}`;
    const list = map.get(key) ?? [];
    list.push(step.id);
    map.set(key, list);
  }
  return map;
}

function mergeEmission(prev: RunEmission[], next: RunEmission): RunEmission[] {
  // Dedupe by (stepKey, epoch, sequence) — the stream replays a snapshot on
  // every (re)connect.
  const dedupeKey = `${next.stepKey}|${next.epoch}|${next.sequence}`;
  if (prev.some((e) => `${e.stepKey}|${e.epoch}|${e.sequence}` === dedupeKey)) {
    return prev;
  }
  return [...prev, next];
}

/** Yield parsed objects from a newline-delimited JSON stream, honoring abort. */
async function* readNdjson<T>(
  body: ReadableStream<unknown>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error("Workflow emission stream produced a non-binary chunk");
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          yield JSON.parse(trimmed) as T;
        }
      }
    }
    const tail = buffer.trim();
    if (tail && !signal.aborted) {
      yield JSON.parse(tail) as T;
    }
  } finally {
    reader.releaseLock();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });
}
