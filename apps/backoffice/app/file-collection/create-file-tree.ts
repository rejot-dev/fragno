import type { FileTree, FileTreeEntry } from "./file-collection";

/**
 * Builds the flat tree shared by file collection adapters.
 *
 * Explicit directories are preserved, and missing parent directories are synthesized so every
 * entry can be reached by walking down from the implicit root.
 */
export function createFileTree(entries: Iterable<FileTreeEntry>): FileTree {
  const entriesByPath = new Map<string, FileTreeEntry>();

  for (const entry of entries) {
    assertValidFileCollectionPath(entry.path);

    const existingEntry = entriesByPath.get(entry.path);
    if (existingEntry) {
      throw new Error(
        `File tree path '${entry.path}' is both a ${existingEntry.kind} and a ${entry.kind}.`,
      );
    }

    entriesByPath.set(entry.path, entry);
  }

  for (const entry of Array.from(entriesByPath.values())) {
    const segments = entry.path.split("/");

    for (let index = 1; index < segments.length; index += 1) {
      const directoryPath = segments.slice(0, index).join("/");
      const existingDirectory = entriesByPath.get(directoryPath);

      if (existingDirectory?.kind === "file") {
        throw new Error(
          `File '${directoryPath}' cannot be the parent directory of '${entry.path}'.`,
        );
      }

      if (!existingDirectory) {
        entriesByPath.set(directoryPath, {
          kind: "directory",
          path: directoryPath,
          updatedAt: null,
          metadata: null,
        });
      }
    }
  }

  return {
    entries: Array.from(entriesByPath.values()).sort((left, right) => {
      const pathOrder = left.path.localeCompare(right.path, "en", {
        numeric: true,
        sensitivity: "base",
      });
      if (pathOrder !== 0) {
        return pathOrder;
      }
      return left.kind === right.kind ? 0 : left.kind === "directory" ? -1 : 1;
    }),
  };
}

export function assertValidFileCollectionPath(path: string): void {
  if (!path) {
    throw new Error("A file tree entry cannot represent the implicit root.");
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`File tree path '${path}' contains an empty path segment.`);
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`File tree path '${path}' contains a traversal path segment.`);
  }
}
