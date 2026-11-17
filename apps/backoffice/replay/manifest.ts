import type { BackofficeJurisdiction } from "@fragno-dev/backoffice-api/v0/shared/scope";

/**
 * `scripts/universe-replay/capture.ts` records each organization's universe in its own directory,
 * named by its slug, holding this manifest and its streams.
 */
export const UNIVERSE_REPLAY_MANIFEST_FILE = "manifest.json";

/** Where the replay app's server lists every recorded organization's manifest. */
export const UNIVERSE_REPLAY_MANIFESTS_PATH = "/__universe-replay/manifests.json";

/** A recorded scope's Automations backend, which its replica checks the stream against. */
type RecordedBackend = { adapterIdentity: string };

/**
 * An organization's universe as recorded from a Leyway server: the scopes its Map opens, as its
 * loader describes them to the person who recorded it, and each scope's Automations outbox.
 */
export type UniverseReplayManifest = {
  capturedAt: string;
  from: string;
  organization: RecordedBackend & {
    id: string;
    slug: string;
    name: string;
    jurisdiction: BackofficeJurisdiction | null;
  };
  projects: (RecordedBackend & { id: string; slug: string; name: string })[];
  /** Whoever recorded it, as the person looking. */
  viewer: RecordedBackend & {
    userId: string;
    jurisdiction: BackofficeJurisdiction | null;
    label: string;
  };
  /**
   * Each scope's outbox by the route path its Automations backend is served at: its entries, one
   * JSON per line, in a file beside the manifest, and the last one.
   */
  streams: Record<string, RecordedBackend & { file: string; throughVersionstamp: string | null }>;
};
