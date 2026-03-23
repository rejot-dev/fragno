import { normalizeMountPoint } from "./normalize-path";
import type { FileContributor } from "./types";

const contributors = new Map<string, FileContributor>();

export const registerFileContributor = (contributor: FileContributor): void => {
  const contributorId = contributor.id.trim();
  if (contributorId.length === 0) {
    throw new Error("File contributor id cannot be empty.");
  }

  if (contributors.has(contributorId)) {
    throw new Error(`File contributor '${contributorId}' is already registered.`);
  }

  contributors.set(contributorId, {
    ...contributor,
    id: contributorId,
    mountPoint: normalizeMountPoint(contributor.mountPoint),
  });
};

export const getRegisteredFileContributor = (id: string): FileContributor | null => {
  return contributors.get(id) ?? null;
};

export const getRegisteredFileContributors = (): FileContributor[] => {
  return Array.from(contributors.values());
};

export const resetFileContributorsForTest = (): void => {
  contributors.clear();
};
