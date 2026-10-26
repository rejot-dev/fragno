import { backofficeScopePathSegment } from "@fragno-dev/backoffice-api/v0/shared/scope";
import { DurableObject } from "cloudflare:workers";

import type { PresenceCommands } from "@/backoffice-runtime/object-registry";
import type {
  PresenceActivity,
  PresenceActivityResult,
  PresenceMember,
} from "@/presence/contracts";

import type { BackofficeObjectState } from "./lib/backoffice-fragment-durable-object";

// Page requests are the only activity signal, so the window must outlast reading one page.
const ACTIVITY_WINDOW_MS = 5 * 60_000;
const ENTRY_KEY_PREFIX = "member:";

type PresenceEntry = {
  member: PresenceMember;
  /** Compared with the next activity's scope; members never see it. */
  scopeSegment: string;
};

function isActive(entry: PresenceEntry, nowEpochMs: number) {
  return Date.parse(entry.member.lastActiveAt) > nowEpochMs - ACTIVITY_WINDOW_MS;
}

// Entries live in storage rather than memory: requests are sparse enough that Cloudflare may
// evict the object between two activities of a member who is still present.
export class PresenceObject implements PresenceCommands {
  readonly #storage: DurableObjectStorage;
  readonly #nowEpochMs: () => number;

  constructor({
    state,
    nowEpochMs,
  }: {
    state: Pick<BackofficeObjectState, "storage">;
    nowEpochMs: () => number;
  }) {
    this.#storage = state.storage;
    this.#nowEpochMs = nowEpochMs;
  }

  async recordActivity({ user, path, scope }: PresenceActivity): Promise<PresenceActivityResult> {
    const now = this.#nowEpochMs();
    const key = `${ENTRY_KEY_PREFIX}${user.id}`;
    const scopeSegment = backofficeScopePathSegment(scope);
    const previous = await this.#storage.get<PresenceEntry>(key);
    await this.#storage.put(key, {
      member: {
        userId: user.id,
        email: user.email,
        path,
        lastActiveAt: new Date(now).toISOString(),
      },
      scopeSegment,
    } satisfies PresenceEntry);
    return {
      enteredScope: !previous || !isActive(previous, now) || previous.scopeSegment !== scopeSegment,
    };
  }

  async listActiveMembers(): Promise<PresenceMember[]> {
    const now = this.#nowEpochMs();
    const entries = await this.#storage.list<PresenceEntry>({ prefix: ENTRY_KEY_PREFIX });
    const inactiveKeys = [...entries].flatMap(([key, entry]) =>
      isActive(entry, now) ? [] : [key],
    );
    if (inactiveKeys.length > 0) {
      await this.#storage.delete(inactiveKeys);
    }
    return [...entries.values()]
      .filter((entry) => isActive(entry, now))
      .map((entry) => entry.member)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }
}

export class Presence extends DurableObject<CloudflareEnv> implements PresenceCommands {
  readonly #object: PresenceObject;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    this.#object = new PresenceObject({ state, nowEpochMs: Date.now });
  }

  async recordActivity(activity: PresenceActivity): Promise<PresenceActivityResult> {
    return await this.#object.recordActivity(activity);
  }

  async listActiveMembers(): Promise<PresenceMember[]> {
    return await this.#object.listActiveMembers();
  }
}
