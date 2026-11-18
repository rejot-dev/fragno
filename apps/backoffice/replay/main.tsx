// The universe replay app: Backoffice's universe panel, drawing organizations recorded from a Leyway
// server by `universe-replay:capture`. vite.replay.config.ts serves it, and the recordings.
import "./replay.css";
import "@fragno-private/design-system/components.css";

import { BackofficeDownloadState } from "@fragno-private/design-system/feedback/download-state";
import { BackofficeSystemState } from "@fragno-private/design-system/feedback/system-state";
import { StrictMode, Suspense, use, useMemo } from "react";
import { createRoot } from "react-dom/client";

import type { BackofficeScopeSelection } from "@/backoffice-runtime/resolved-scope";
import { getAutomationReplica } from "@/fragno/automation/lofi/replica";
import type { AutomationReplicaSource } from "@/fragno/automation/lofi/replica-source";
import { LofiReplicaGate } from "@/fragno/lofi/replica-gate";
import {
  OrganizationUniverseAt,
  type OrchestrationUniverseScopes,
} from "@/routes/backoffice/dashboard/orchestration-universe-panel";

import { UNIVERSE_REPLAY_MANIFESTS_PATH, type UniverseReplayManifest } from "./manifest";

const DOWNLOAD_TITLE = "Replaying the recorded automation activity…";
const CAPTURE_COMMAND = "pnpm --filter @fragno-apps/backoffice-rr universe-replay:capture";

const manifests = fetch(UNIVERSE_REPLAY_MANIFESTS_PATH).then((response) => {
  if (!response.ok) {
    throw new Error(`Listing the recordings returned ${response.status}.`);
  }
  return response.json<UniverseReplayManifest[]>();
});

/**
 * Where an organization's recording replays: at an origin of its own, `<slug>.localhost`, which the
 * replay server serves its scopes at, and where the browser keeps their replicas apart from other
 * recordings'.
 */
function recordingUrl(orgSlug: string): string {
  const { protocol, port } = window.location;
  return `${protocol}//${orgSlug}.localhost${port ? `:${port}` : ""}/replay/${orgSlug}`;
}

/** The organization and the scopes its Map opens, as its loader described them to the recorder. */
function replayedScopes(manifest: UniverseReplayManifest) {
  const organization = {
    id: manifest.organization.id,
    slug: manifest.organization.slug,
    jurisdiction: manifest.organization.jurisdiction,
  };
  const selectedScope: Extract<BackofficeScopeSelection, { kind: "org" }> = {
    kind: "org",
    organization,
    label: manifest.organization.name,
  };
  const source: AutomationReplicaSource = {
    resolvedScope: { kind: "org", organization },
    adapterIdentity: manifest.organization.adapterIdentity,
  };
  const { viewer } = manifest;
  const scopes: OrchestrationUniverseScopes = {
    projects: manifest.projects.map((project) => ({ id: project.id, label: project.name })),
    viewer: {
      label: viewer.label,
      source: {
        resolvedScope: { kind: "user", userId: viewer.userId, jurisdiction: viewer.jurisdiction },
        adapterIdentity: viewer.adapterIdentity,
      },
    },
    memberNames: { [viewer.userId]: viewer.label },
    problems: [],
  };
  return { selectedScope, source, scopes };
}

function ReplayedUniverse({ manifest }: { manifest: UniverseReplayManifest }) {
  const { selectedScope, source, scopes } = useMemo(() => replayedScopes(manifest), [manifest]);
  const replica = use(getAutomationReplica(source));
  return (
    <LofiReplicaGate replica={replica} title={DOWNLOAD_TITLE}>
      <OrganizationUniverseAt
        replica={replica}
        selectedScope={selectedScope}
        scopes={scopes}
        now={Date.parse(manifest.capturedAt)}
      />
    </LofiReplicaGate>
  );
}

function ReplayedOrganization({ orgSlug }: { orgSlug: string }) {
  const manifest = use(manifests).find(({ organization }) => organization.slug === orgSlug);
  if (!manifest) {
    return (
      <BackofficeSystemState
        tone="empty"
        label="Not recorded"
        title={`Nothing is recorded for ${orgSlug}`}
        description={`Run \`${CAPTURE_COMMAND} org:${orgSlug}\`.`}
      />
    );
  }
  return (
    <>
      <header>
        <a href="/replay/" className="text-sm text-[var(--bo-muted)]">
          Recorded organizations
        </a>
        <h1 className="text-lg font-semibold">How {manifest.organization.name} is wired</h1>
        <p className="text-sm text-[var(--bo-muted)]">
          Replayed from {manifest.from}, recorded {manifest.capturedAt}.
        </p>
      </header>
      <Suspense
        fallback={<BackofficeDownloadState title={DOWNLOAD_TITLE} fraction={null} error={null} />}
      >
        <ReplayedUniverse manifest={manifest} />
      </Suspense>
    </>
  );
}

function RecordedOrganizations() {
  const recorded = use(manifests);
  return (
    <>
      <h1 className="text-lg font-semibold">Recorded organizations</h1>
      {recorded.length === 0 ? (
        <BackofficeSystemState
          tone="empty"
          label="Nothing recorded"
          title="No organization is recorded yet"
          description={`Run \`${CAPTURE_COMMAND} org:<organization-slug>\`.`}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {recorded.map(({ organization, from, capturedAt }) => (
            <li key={organization.slug}>
              <a href={recordingUrl(organization.slug)} className="font-medium underline">
                {organization.name}
              </a>
              <span className="text-sm text-[var(--bo-muted)]">
                {" "}
                from {from}, recorded {capturedAt}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Replay({ orgSlug }: { orgSlug: string | null }) {
  return (
    <main
      data-backoffice-root
      className="flex flex-1 flex-col gap-4 bg-[var(--bo-bg)] p-6 text-[var(--bo-fg)]"
    >
      <Suspense fallback={null}>
        {orgSlug ? <ReplayedOrganization orgSlug={orgSlug} /> : <RecordedOrganizations />}
      </Suspense>
    </main>
  );
}

const openedPath = /^\/replay\/([^/]+)/.exec(window.location.pathname)?.[1];
const openedSlug = openedPath === undefined ? null : decodeURIComponent(openedPath);
if (openedSlug !== null && window.location.hostname !== `${openedSlug}.localhost`) {
  window.location.replace(recordingUrl(openedSlug));
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html has no #root.");
}
createRoot(root).render(
  <StrictMode>
    <Replay orgSlug={openedSlug} />
  </StrictMode>,
);
