import {
  SessionError,
  type LeafEntry,
  type SessionMetadata,
  type SessionStorage,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";

type PersistSessionEntry = (entry: SessionTreeEntry) => void | Promise<void>;
type AllocateSessionEntryId = () => string;

export type WorkflowBackedSessionEntryIdAllocator = {
  next: AllocateSessionEntryId;
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
  structuredClone(entry) as TEntry;

const leafIdAfterEntry = (entry: SessionTreeEntry): string | null =>
  entry.type === "leaf" ? entry.targetId : entry.id;

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
    this.leafId = null;

    for (const entry of this.entries) {
      this.leafId = leafIdAfterEntry(entry);
    }

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

  async getEntries(): Promise<SessionTreeEntry[]> {
    return this.entries.map(cloneEntry);
  }
}
