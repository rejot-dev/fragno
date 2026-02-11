export type IndexKey = readonly unknown[];

export type SortedArrayIndexEntry<T> = {
  key: IndexKey;
  value: T;
};

export class UniqueConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniqueConstraintError";
  }
}

export type CompareValue = (left: unknown, right: unknown) => number;

export type SortedArrayIndexOptions = {
  unique?: boolean;
};

export type UniqueEnforcementOptions = {
  enforceUnique?: boolean;
};

export type IndexScanOptions = {
  start?: IndexKey;
  startInclusive?: boolean;
  end?: IndexKey;
  endInclusive?: boolean;
  direction?: "asc" | "desc";
  limit?: number;
};

const compareKeys = (left: IndexKey, right: IndexKey, compareValue: CompareValue): number => {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const result = compareValue(left[i], right[i]);
    if (result !== 0) {
      return result;
    }
  }

  return left.length - right.length;
};

export class SortedArrayIndex<T> {
  #entries: SortedArrayIndexEntry<T>[] = [];
  #compareValue: CompareValue;
  #unique: boolean;

  constructor(compareValue: CompareValue, options: SortedArrayIndexOptions = {}) {
    this.#compareValue = compareValue;
    this.#unique = options.unique ?? false;
  }

  get size(): number {
    return this.#entries.length;
  }

  entries(): SortedArrayIndexEntry<T>[] {
    return this.#entries.slice();
  }

  insert(key: IndexKey, value: T, options: UniqueEnforcementOptions = {}): void {
    const enforceUnique = options.enforceUnique ?? true;
    if (this.#unique && enforceUnique) {
      this.#assertUnique(key);
    }
    const entry = { key, value };
    const index = this.#upperBound(key);
    this.#entries.splice(index, 0, entry);
  }

  remove(key: IndexKey, value?: T): boolean {
    const start = this.#lowerBound(key);
    const end = this.#upperBound(key);
    if (start === end) {
      return false;
    }

    if (value === undefined) {
      this.#entries.splice(start, 1);
      return true;
    }

    for (let i = start; i < end; i += 1) {
      if (this.#entries[i]?.value === value) {
        this.#entries.splice(i, 1);
        return true;
      }
    }

    return false;
  }

  update(
    oldKey: IndexKey,
    newKey: IndexKey,
    value: T,
    options: UniqueEnforcementOptions = {},
  ): void {
    const enforceUnique = options.enforceUnique ?? true;
    if (this.#unique && enforceUnique) {
      const range = this.#rangeForKey(newKey);
      if (range.start !== range.end) {
        const sameKey = compareKeys(oldKey, newKey, this.#compareValue) === 0;
        const singleEntry = range.end - range.start === 1;
        const entry = this.#entries[range.start];
        const isSameEntry = sameKey && singleEntry && entry?.value === value;
        if (!isSameEntry) {
          throw new UniqueConstraintError(this.#uniqueErrorMessage(newKey));
        }
        if (sameKey) {
          return;
        }
      }
    }
    const removed = this.remove(oldKey, value);
    if (!removed) {
      throw new Error("SortedArrayIndex update failed to locate existing entry.");
    }
    this.insert(newKey, value, { enforceUnique });
  }

  scan(options: IndexScanOptions = {}): SortedArrayIndexEntry<T>[] {
    const direction = options.direction ?? "asc";
    const limit = options.limit ?? Number.POSITIVE_INFINITY;

    const start = options.start
      ? options.startInclusive === false
        ? this.#upperBound(options.start)
        : this.#lowerBound(options.start)
      : 0;

    const end = options.end
      ? options.endInclusive === true
        ? this.#upperBound(options.end)
        : this.#lowerBound(options.end)
      : this.#entries.length;

    if (start >= end || limit <= 0) {
      return [];
    }

    const results: SortedArrayIndexEntry<T>[] = [];

    if (direction === "desc") {
      for (let i = end - 1; i >= start && results.length < limit; i -= 1) {
        results.push(this.#entries[i]);
      }
      return results;
    }

    for (let i = start; i < end && results.length < limit; i += 1) {
      results.push(this.#entries[i]);
    }

    return results;
  }

  #compareEntryWithKey(entry: SortedArrayIndexEntry<T>, key: IndexKey): number {
    return compareKeys(entry.key, key, this.#compareValue);
  }

  #rangeForKey(key: IndexKey): { start: number; end: number } {
    return {
      start: this.#lowerBound(key),
      end: this.#upperBound(key),
    };
  }

  #assertUnique(key: IndexKey): void {
    const range = this.#rangeForKey(key);
    if (range.start !== range.end) {
      throw new UniqueConstraintError(this.#uniqueErrorMessage(key));
    }
  }

  #uniqueErrorMessage(key: IndexKey): string {
    return `Unique constraint violation for key ${this.#formatKey(key)}.`;
  }

  #formatKey(key: IndexKey): string {
    const parts = key.map((value) => this.#formatKeyValue(value));
    return `[${parts.join(", ")}]`;
  }

  #formatKeyValue(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "bigint") {
      return `${value}n`;
    }
    return String(value);
  }

  #lowerBound(key: IndexKey): number {
    let low = 0;
    let high = this.#entries.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entry = this.#entries[mid];
      const comparison = entry ? this.#compareEntryWithKey(entry, key) : 0;
      if (comparison < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }

  #upperBound(key: IndexKey): number {
    let low = 0;
    let high = this.#entries.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const entry = this.#entries[mid];
      const comparison = entry ? this.#compareEntryWithKey(entry, key) : 0;
      if (comparison <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }
}
