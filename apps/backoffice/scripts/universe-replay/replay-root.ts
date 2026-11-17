import { homedir } from "node:os";
import path from "node:path";

/**
 * Where recorded universes are kept: outside the repository, so every worktree's replay app
 * replays the same recordings, which hold real events. `LEYWAY_UNIVERSE_REPLAY_DIR` moves them.
 */
export function universeReplayRoot(): string {
  const configured = process.env.LEYWAY_UNIVERSE_REPLAY_DIR?.trim();
  if (configured) {
    return path.resolve(
      configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured,
    );
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local/share");
  return path.resolve(dataHome, "leyway/universe-replay");
}
