import type { SandboxWorkspaceSnapshot } from "./schema";

// Cloudflare refreshes retention on restoration; keep a day of margin on its 30-day TTL.
const WORKSPACE_SNAPSHOT_LIFETIME_MS = 29 * 24 * 60 * 60 * 1000;

export function sandboxWorkspaceSnapshotExpiresAt(retainedAt: string): string {
  return new Date(Date.parse(retainedAt) + WORKSPACE_SNAPSHOT_LIFETIME_MS).toISOString();
}

export function isSandboxWorkspaceSnapshotResumable(
  snapshot: SandboxWorkspaceSnapshot | null,
  now: number,
): snapshot is SandboxWorkspaceSnapshot {
  return snapshot !== null && Date.parse(snapshot.expiresAt) > now;
}
