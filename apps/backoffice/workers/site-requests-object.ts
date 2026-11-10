import {
  ARTIFACT_SITE_REQUEST_TIMEOUT_MS,
  type ArtifactSiteLogEntry,
  type ArtifactSiteRequestInput,
  type ArtifactSiteResponse,
} from "@fragno-dev/backoffice-api/v0/artifacts";
import {
  backofficeContextScopesEqual,
  type BackofficeContextScope,
} from "@fragno-dev/backoffice-api/v0/shared/scope";
import type { FragmentDurableObjectHost } from "@fragno-dev/db/dispatchers/cloudflare-do/fragment-durable-object";

import {
  fetchSiteWorker,
  loadProbedSiteWorker,
  type SiteWorkerBindings,
} from "@/artifacts/sites/serve.server";
import { SITE_EVENT_LIMITS, type SiteProbeEvent } from "@/artifacts/sites/site-events";
import type { SiteProbeReport } from "@/artifacts/sites/site-logs";
import { aborted, siteProbeRequest, siteProbeResponse } from "@/artifacts/sites/site-request";
import {
  requireBackofficeContextScopeFromDurableObjectId,
  type SiteRequestsCommands,
  type SiteRequestsQuery,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import {
  createSiteRequestsServer,
  type SiteRequestsFragment,
} from "@/fragno/site-requests/site-requests-fragment";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";
import type { BackofficeObjectImplementation } from "./lib/backoffice-object-implementation";

/**
 * How long a request an agent sends waits for the runtime to report what the Worker logged; it
 * reports a request shortly after the request ends.
 */
const PROBE_REPORT_WAIT_MS = 5_000;

/** The answer to a request whose Worker threw: a viewer gets Backoffice's error page. */
const THREW: Omit<ArtifactSiteResponse, "log" | "events"> = {
  status: 500,
  headers: {},
  body: null,
  bodyError: null,
};

/**
 * The requests one scope's sites handle: what each logged and threw, as their tails report it, for
 * the latest requests of each site for a day; and the requests agents send them, which run here so
 * that the tail reporting each one finds the agent waiting for it.
 */
export class SiteRequestsObject implements SiteRequestsCommands {
  readonly #host: FragmentDurableObjectHost<void, SiteRequestsFragment>;
  readonly #scope: BackofficeContextScope;
  readonly #runtime: BackofficeRuntimeServices;
  readonly #siteWorkerBindings: SiteWorkerBindings;
  readonly #nowEpochMs: () => number;
  /** The requests agents sent whose record has not arrived, by probe. */
  readonly #probes = new Map<string, (entry: ArtifactSiteLogEntry) => void>();
  /** The events the Workers of requests agents sent fired, by probe. */
  readonly #probeEvents = new Map<string, SiteProbeEvent[]>();
  #fragment: SiteRequestsFragment | null = null;

  constructor({
    state,
    runtime,
    implementation,
    nowEpochMs,
    siteWorkerBindings,
  }: {
    state: BackofficeObjectState;
    runtime: BackofficeRuntimeServices;
    implementation: BackofficeObjectImplementation;
    nowEpochMs: () => number;
    /** What the site Workers this object loads are bound to. */
    siteWorkerBindings: SiteWorkerBindings;
  }) {
    this.#scope = requireBackofficeContextScopeFromDurableObjectId(state.id, "SITE_REQUESTS");
    this.#runtime = runtime;
    this.#siteWorkerBindings = siteWorkerBindings;
    this.#nowEpochMs = nowEpochMs;
    this.#host = implementation.createFragmentHost({
      name: "SiteRequests",
      createRuntime: () => createSiteRequestsServer(implementation.fragmentDatabase),
      onProcessError: (error) => {
        console.error("Site requests hook processor error", error);
      },
      onDispatcherError: (error) => {
        console.warn("Site requests hook dispatcher initialization failed", error);
      },
    });
    void state.blockConcurrencyWhile(async () => {
      this.#fragment = await this.#host.initialize(undefined);
    });
  }

  #getFragment(scope: BackofficeContextScope): SiteRequestsFragment {
    if (!backofficeContextScopesEqual(scope, this.#scope)) {
      throw new Error("Site requests are kept by the object of their own scope.");
    }
    if (!this.#fragment) {
      throw new Error("Site requests are unavailable.");
    }
    return this.#fragment;
  }

  async request(
    scope: BackofficeContextScope,
    input: ArtifactSiteRequestInput,
  ): Promise<ArtifactSiteResponse> {
    this.#getFragment(scope);
    const request = siteProbeRequest(input);
    // Covers the answer and its body, so a Worker that never answers, or streams on, ends here.
    const deadline = AbortSignal.timeout(ARTIFACT_SITE_REQUEST_TIMEOUT_MS);
    const probe = crypto.randomUUID();
    const loaded = await loadProbedSiteWorker({
      runtime: this.#runtime,
      bindings: this.#siteWorkerBindings,
      scope,
      sitePath: input.path,
      probe: { id: probe, fire: input.fire ?? false },
    });
    // The host answered: the site has no build to run.
    if (loaded.kind === "answered") {
      return { ...(await siteProbeResponse(loaded.response, deadline)), log: null, events: [] };
    }
    const events: SiteProbeEvent[] = [];
    this.#probeEvents.set(probe, events);
    // Waits from before the request, as a tail may report it before its answer arrives.
    const reported = new Promise<ArtifactSiteLogEntry>((resolve) => {
      this.#probes.set(probe, resolve);
    });
    try {
      const response = await Promise.race([
        fetchSiteWorker(
          loaded.worker,
          request,
          new URL(request.url).pathname,
          input.viewer ?? null,
        ).catch(() => null),
        aborted(deadline),
      ]);
      if (response === "aborted") {
        throw new Error(
          `${input.path} did not answer ${input.url ?? "/"} within ${ARTIFACT_SITE_REQUEST_TIMEOUT_MS / 1000} seconds.`,
        );
      }
      const answer = response ? await siteProbeResponse(response, deadline) : THREW;
      return { ...answer, log: await within(reported, PROBE_REPORT_WAIT_MS), events };
    } finally {
      this.#probes.delete(probe);
      this.#probeEvents.delete(probe);
    }
  }

  async keepProbeEvent(
    scope: BackofficeContextScope,
    probe: string,
    event: SiteProbeEvent,
  ): Promise<boolean> {
    this.#getFragment(scope);
    const events = this.#probeEvents.get(probe);
    // Fired events are limited as viewers' are; those kept instead stop at as many.
    if (event.eventId === null && events && events.length >= SITE_EVENT_LIMITS.perViewer) {
      return false;
    }
    // A Worker may fire after its request was answered, when the agent is gone and keeps nothing.
    events?.push(event);
    return true;
  }

  async append(
    scope: BackofficeContextScope,
    sitePath: string,
    entries: ArtifactSiteLogEntry[],
    probe: SiteProbeReport | null,
  ): Promise<void> {
    const fragment = this.#getFragment(scope);
    if (probe) {
      this.#probes.get(probe.id)?.(probe.entry);
    }
    if (entries.length > 0) {
      await fragment.callServices(() =>
        fragment.services.recordSiteRequests({
          site: sitePath,
          entries,
          now: new Date(this.#nowEpochMs()),
        }),
      );
    }
  }

  async read(
    scope: BackofficeContextScope,
    query: SiteRequestsQuery,
  ): Promise<ArtifactSiteLogEntry[]> {
    const fragment = this.#getFragment(scope);
    return await fragment.callServices(() =>
      fragment.services.readSiteRequests({
        site: query.sitePath,
        since: query.since === null ? null : new Date(query.since),
        errorsOnly: query.errorsOnly,
        limit: query.limit,
        now: new Date(this.#nowEpochMs()),
      }),
    );
  }

  async alarm(): Promise<void> {
    await this.#host.alarm();
  }
}

/** What `promise` resolves to within `ms`, or null. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
