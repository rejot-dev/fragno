import { Link, useLoaderData } from "react-router";

import {
  GITHUB_WEBHOOK_ROUTER_SINGLETON_ID,
  getGitHubWebhookRouterDurableObject,
} from "@/cloudflare/cloudflare-utils";
import { BackofficePageHeader, FormContainer } from "@/components/backoffice";

import type { Route } from "./+types/github";

type GitHubAdminConfigState = {
  configured: boolean;
  missing: string[];
  error: string | null;
  app?: {
    appId: string;
    appSlug: string;
    privateKeySource: "env" | "file";
    webhookSecretPreview: string;
    webhookUrl: string;
    installUrl: string;
    docsUrl: string;
  };
};

type GitHubWebhookRouterSnapshot = {
  installationMappings: Array<{
    installationId: string;
    orgId: string;
  }>;
  pendingWebhooks: Array<{
    key: string;
    installationId: string;
    method: string;
    event: string;
    deliveryId: string;
    receivedAt: number;
  }>;
  activeInstallStates: Array<{
    statePreview: string;
    userId: string;
    orgId: string;
    createdAt: number;
    expiresAt: number;
  }>;
  counts: {
    installationMappings: number;
    pendingWebhooks: number;
    activeInstallStates: number;
  };
};

type LoaderData = {
  configState: GitHubAdminConfigState | null;
  configError: string | null;
  snapshot: GitHubWebhookRouterSnapshot | null;
  snapshotError: string | null;
  setupUrl: string;
};

const formatTimestamp = (value?: number | Date | null) => {
  if (!value) {
    return "n/a";
  }
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export function meta() {
  return [
    { title: "Backoffice Internals · GitHub" },
    {
      name: "description",
      content: "Inspect GitHub app runtime config and singleton routing state.",
    },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  const setupUrl = `${origin.replace(/\/+$/, "")}/backoffice/connections/github/setup-callback`;
  const githubRouterDo = getGitHubWebhookRouterDurableObject(context);

  let configState: GitHubAdminConfigState | null = null;
  let configError: string | null = null;
  let snapshot: GitHubWebhookRouterSnapshot | null = null;
  let snapshotError: string | null = null;

  try {
    configState = await githubRouterDo.getAdminConfig(GITHUB_WEBHOOK_ROUTER_SINGLETON_ID, origin);
  } catch (error) {
    configError =
      error instanceof Error ? error.message : "Failed to load GitHub app runtime configuration.";
  }

  try {
    snapshot = await githubRouterDo.getWebhookRouterSnapshot();
  } catch (error) {
    snapshotError =
      error instanceof Error ? error.message : "Failed to load singleton routing snapshot.";
  }

  return {
    configState,
    configError,
    snapshot,
    snapshotError,
    setupUrl,
  } satisfies LoaderData;
}

export default function BackofficeInternalsGitHub() {
  const { configState, configError, snapshot, snapshotError, setupUrl } =
    useLoaderData<typeof loader>();

  return (
    <div className="space-y-4">
      <BackofficePageHeader
        breadcrumbs={[
          { label: "Backoffice", to: "/backoffice" },
          { label: "Internals", to: "/backoffice/internals" },
          { label: "GitHub" },
        ]}
        eyebrow="Internals"
        title="GitHub operator console"
        description="Runtime setup and singleton webhook routing state."
        actions={
          <Link
            to="/backoffice/internals"
            className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
          >
            Back to internals
          </Link>
        }
      />

      <FormContainer
        title="Runtime configuration"
        eyebrow="GitHub App"
        description="Operator-facing values used by the global install callback and webhook router."
      >
        {configError ? <p className="text-sm text-red-500">{configError}</p> : null}
        {!configState ? (
          <p className="text-sm text-[var(--bo-muted)]">Configuration is unavailable.</p>
        ) : (
          <div className="space-y-3 text-sm text-[var(--bo-muted)]">
            <p>
              Status:{" "}
              <span className="font-semibold text-[var(--bo-fg)]">
                {configState.configured ? "configured" : "not configured"}
              </span>
            </p>
            {configState.missing.length > 0 ? (
              <p>
                Missing:{" "}
                <span className="text-[var(--bo-fg)]">{configState.missing.join(", ")}</span>
              </p>
            ) : null}
            {configState.error ? <p className="text-red-500">{configState.error}</p> : null}
            {configState.app ? (
              <div className="space-y-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                <p>
                  App:{" "}
                  <span className="text-[var(--bo-fg)]">
                    {configState.app.appSlug} ({configState.app.appId})
                  </span>
                </p>
                <p>
                  Private key source:{" "}
                  <span className="text-[var(--bo-fg)]">{configState.app.privateKeySource}</span>
                </p>
                <p>
                  Webhook URL:{" "}
                  <span className="break-all text-[var(--bo-fg)]">
                    {configState.app.webhookUrl}
                  </span>
                </p>
                <p>
                  Setup URL: <span className="break-all text-[var(--bo-fg)]">{setupUrl}</span>
                </p>
                <p>
                  Install URL:{" "}
                  <span className="break-all text-[var(--bo-fg)]">
                    {configState.app.installUrl}
                  </span>
                </p>
              </div>
            ) : null}
          </div>
        )}
      </FormContainer>

      <FormContainer
        title="Singleton routing state"
        eyebrow="Durable Object"
        description="Installation links and queued webhook events held by the global webhook router."
      >
        {snapshotError ? <p className="text-sm text-red-500">{snapshotError}</p> : null}
        {!snapshot ? (
          <p className="text-sm text-[var(--bo-muted)]">Routing snapshot is unavailable.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Installation links
                </p>
                <p className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                  {snapshot.counts.installationMappings}
                </p>
              </div>
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Pending webhooks
                </p>
                <p className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                  {snapshot.counts.pendingWebhooks}
                </p>
              </div>
              <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-3">
                <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
                  Active install states
                </p>
                <p className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">
                  {snapshot.counts.activeInstallStates}
                </p>
              </div>
            </div>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-[var(--bo-fg)]">
                Installation ↔ organisation links
              </h2>
              {snapshot.installationMappings.length === 0 ? (
                <p className="text-sm text-[var(--bo-muted)]">
                  No installation mappings stored yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {snapshot.installationMappings.map((mapping) => (
                    <div
                      key={`${mapping.installationId}:${mapping.orgId}`}
                      className="flex flex-wrap items-center justify-between gap-2 border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm"
                    >
                      <p className="text-[var(--bo-muted)]">
                        Installation{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">
                          {mapping.installationId}
                        </span>{" "}
                        → Organisation{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">{mapping.orgId}</span>
                      </p>
                      <Link
                        to={`/backoffice/connections/github/${mapping.orgId}/configuration`}
                        className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] px-2 py-1 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
                      >
                        Open org
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-[var(--bo-fg)]">Pending webhook queue</h2>
              {snapshot.pendingWebhooks.length === 0 ? (
                <p className="text-sm text-[var(--bo-muted)]">No pending webhooks in queue.</p>
              ) : (
                <div className="space-y-2">
                  {snapshot.pendingWebhooks.map((entry) => (
                    <div
                      key={entry.key}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-muted)]"
                    >
                      <p>
                        Installation{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">
                          {entry.installationId}
                        </span>{" "}
                        · event{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">
                          {entry.event || "unknown"}
                        </span>{" "}
                        · method{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">{entry.method}</span>
                      </p>
                      <p className="text-xs text-[var(--bo-muted-2)]">
                        Delivery {entry.deliveryId || "unknown"} · received{" "}
                        {formatTimestamp(entry.receivedAt)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-[var(--bo-fg)]">Active install states</h2>
              {snapshot.activeInstallStates.length === 0 ? (
                <p className="text-sm text-[var(--bo-muted)]">No active install states.</p>
              ) : (
                <div className="space-y-2">
                  {snapshot.activeInstallStates.map((state) => (
                    <div
                      key={`${state.statePreview}:${state.userId}:${state.orgId}:${state.createdAt}`}
                      className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-sm text-[var(--bo-muted)]"
                    >
                      <p>
                        State{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">
                          {state.statePreview}
                        </span>{" "}
                        · user{" "}
                        <span className="font-semibold text-[var(--bo-fg)]">{state.userId}</span> ·
                        org <span className="font-semibold text-[var(--bo-fg)]">{state.orgId}</span>
                      </p>
                      <p className="text-xs text-[var(--bo-muted-2)]">
                        Created {formatTimestamp(state.createdAt)} · expires{" "}
                        {formatTimestamp(state.expiresAt)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </FormContainer>
    </div>
  );
}
