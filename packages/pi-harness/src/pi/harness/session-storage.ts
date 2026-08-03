import {
  SessionError,
  type LeafEntry,
  type SessionEntryCursorOptions,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

type PersistSessionEntry = (entry: SessionTreeEntry) => void | Promise<void>;
type AllocateSessionEntryId = () => string;

export type WorkflowBackedSessionEntryIdAllocator = {
  next: AllocateSessionEntryId;
};

export const nextWorkflowBackedSessionEntryIndex = (options: {
  prefix: string;
  entries: readonly SessionTreeEntry[];
}): number => {
  const idPrefix = `${options.prefix}-`;
  let highestIndex = -1;

  for (const entry of options.entries) {
    if (!entry.id.startsWith(idPrefix)) {
      continue;
    }

    const index = Number(entry.id.slice(idPrefix.length));
    if (Number.isSafeInteger(index) && index >= 0) {
      highestIndex = Math.max(highestIndex, index);
    }
  }

  return highestIndex + 1;
};

export const createWorkflowBackedSessionEntryIdAllocator = (options: {
  prefix: string;
  startIndex: number;
}): WorkflowBackedSessionEntryIdAllocator => {
  let nextIndex = options.startIndex;
  return {
    next: () => {
      const id = `${options.prefix}-${nextIndex}`;
      nextIndex += 1;
      return id;
    },
  };
};

export type WorkflowBackedSessionStorageOptions<
  TMetadata extends SessionMetadata = SessionMetadata,
> = {
  metadata: TMetadata;
  entryIds: WorkflowBackedSessionEntryIdAllocator;
  entries?: readonly SessionTreeEntry[];
  /**
   * Optional append hook used by workflow/database adapters to persist or emit
   * entries after the in-memory projection has accepted them.
   */
  onAppendEntry?: PersistSessionEntry;
};

const cloneEntry = <TEntry extends SessionTreeEntry>(entry: TEntry): TEntry =>
  structuredClone(entry);

const leafIdAfterEntry = (entry: SessionTreeEntry): string | null =>
  entry.type === "leaf" ? entry.targetId : entry.id;

export const sessionEntriesLeafId = (entries: readonly SessionTreeEntry[]): string | null => {
  let leafId: string | null = null;
  for (const entry of entries) {
    leafId = leafIdAfterEntry(entry);
  }
  return leafId;
};

const updateLabelCache = (labelsById: Map<string, string>, entry: SessionTreeEntry): void => {
  if (entry.type !== "label") {
    return;
  }

  const label = entry.label?.trim();
  if (label) {
    labelsById.set(entry.targetId, label);
  } else {
    labelsById.delete(entry.targetId);
  }
};

const buildLabelsById = (entries: readonly SessionTreeEntry[]): Map<string, string> => {
  const labelsById = new Map<string, string>();
  for (const entry of entries) {
    updateLabelCache(labelsById, entry);
  }
  return labelsById;
};

const createUniqueEntryId = (
  byId: ReadonlyMap<string, SessionTreeEntry>,
  allocator: WorkflowBackedSessionEntryIdAllocator,
): string => {
  for (let i = 0; i < 100; i += 1) {
    const id = allocator.next();
    if (!byId.has(id)) {
      return id;
    }
  }

  throw new SessionError(
    "invalid_session",
    "Session entry id allocator repeatedly returned used ids",
  );
};

export class WorkflowBackedSessionStorage<
  TMetadata extends SessionMetadata = SessionMetadata,
> implements SessionStorage<TMetadata> {
  private readonly metadata: TMetadata;
  private readonly onAppendEntry: PersistSessionEntry | undefined;
  private readonly entryIds: WorkflowBackedSessionEntryIdAllocator;
  private readonly entries: SessionTreeEntry[];
  private readonly byId: Map<string, SessionTreeEntry>;
  private readonly labelsById: Map<string, string>;
  private leafId: string | null;

  constructor(options: WorkflowBackedSessionStorageOptions<TMetadata>) {
    this.metadata = options.metadata;
    this.onAppendEntry = options.onAppendEntry;
    this.entryIds = options.entryIds;
    this.entries = (options.entries ?? []).map(cloneEntry);
    this.byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    this.labelsById = buildLabelsById(this.entries);
    this.leafId = sessionEntriesLeafId(this.entries);

    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }
  }

  async getMetadata(): Promise<TMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    if (this.leafId !== null && !this.byId.has(this.leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.leafId} not found`);
    }

    return this.leafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }

    const entry: LeafEntry = {
      type: "leaf",
      id: await this.createEntryId(),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };

    await this.appendEntry(entry);
  }

  async createEntryId(): Promise<string> {
    return createUniqueEntryId(this.byId, this.entryIds);
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    if (this.byId.has(entry.id)) {
      throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
    }

    if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
      throw new SessionError("invalid_entry", `Parent entry ${entry.parentId} not found`);
    }

    const stored = cloneEntry(entry);
    this.entries.push(stored);
    this.byId.set(stored.id, stored);
    updateLabelCache(this.labelsById, stored);
    this.leafId = leafIdAfterEntry(stored);

    await this.onAppendEntry?.(cloneEntry(stored));
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    const entry = this.byId.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.entries
      .filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type)
      .map(cloneEntry);
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getSessionName(): Promise<string | undefined> {
    const entries = await this.findEntries("session_info");
    return entries.at(-1)?.name?.trim() || undefined;
  }

  async getSessionStats() {
    let messageCount = 0;
    let cachedTokens = 0;
    let uncachedTokens = 0;
    let totalTokens = 0;
    let costTotal = 0;

    for (const entry of this.entries) {
      if (entry.type === "message") {
        messageCount += 1;
      }

      const usage =
        entry.type === "message"
          ? entry.message.role === "assistant"
            ? entry.message.usage
            : undefined
          : entry.type === "compaction" || entry.type === "branch_summary"
            ? entry.usage
            : undefined;
      if (!usage) {
        continue;
      }

      cachedTokens += usage.cacheRead;
      uncachedTokens += usage.input + usage.cacheWrite;
      totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      costTotal += usage.cost.total;
    }

    return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) {
      return [];
    }

    const path: SessionTreeEntry[] = [];
    let stopAtEntryId: string | null = null;
    let current = this.byId.get(leafId);
    if (!current) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }

    while (current) {
      path.unshift(cloneEntry(current));
      if (stopAtEntryId !== null && current.id === stopAtEntryId) {
        break;
      }
      if (current.type === "compaction") {
        if (current.retainedTail) {
          break;
        }
        stopAtEntryId = current.firstKeptEntryId ?? null;
      }
      if (!current.parentId) {
        break;
      }

      const parent = this.byId.get(current.parentId);
      if (!parent) {
        throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      }
      current = parent;
    }

    return path;
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) {
      return [];
    }

    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }

    while (current) {
      path.unshift(cloneEntry(current));
      if (!current.parentId) {
        break;
      }

      const parent = this.byId.get(current.parentId);
      if (!parent) {
        throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      }
      current = parent;
    }

    return path;
  }

  async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
    const start = options?.afterEntrySeq ?? 0;
    const end = options?.limit === undefined ? undefined : start + options.limit;
    return this.entries.slice(start, end).map(cloneEntry);
  }
}
