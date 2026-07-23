import type { FileEntryDescriptor } from "./types";

const FILE_ENTRY_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export const compareFileEntries = (
  left: FileEntryDescriptor,
  right: FileEntryDescriptor,
): number => {
  const leftKindOrder = left.kind === "folder" ? 0 : 1;
  const rightKindOrder = right.kind === "folder" ? 0 : 1;
  const kindOrder = leftKindOrder - rightKindOrder;
  if (kindOrder !== 0) {
    return kindOrder;
  }

  return FILE_ENTRY_COLLATOR.compare(left.title ?? left.path, right.title ?? right.path);
};

export const sortFileEntryTree = (entries: readonly FileEntryDescriptor[]): FileEntryDescriptor[] =>
  entries
    .map((entry) => ({
      ...entry,
      children: entry.children ? sortFileEntryTree(entry.children) : undefined,
    }))
    .sort(compareFileEntries);
