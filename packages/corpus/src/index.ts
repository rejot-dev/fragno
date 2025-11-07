import {
  getAvailableSubjectIds,
  loadSubject,
  loadSubjects,
  loadAllSubjects,
  type SubjectInfo,
  type Subject,
} from "./parser";
import { orderSubjects } from "./subject-tree";

/**
 * Get basic information about all available subjects
 * @returns Array of subject info (id and title)
 */
export function getSubjects(): SubjectInfo[] {
  const ids = getAvailableSubjectIds();
  return ids
    .map((id) => {
      const subject = loadSubject(id);
      if (!subject) {
        return null;
      }
      return {
        id: subject.id,
        title: subject.title,
      };
    })
    .filter((s): s is SubjectInfo => s !== null);
}

/**
 * Get one or more subjects by their IDs
 * @param ids Subject IDs to load
 * @returns Array of complete subject data ordered by the subject tree
 * @example
 * ```ts
 * // Get single subject
 * const [routes] = getSubject("defining-routes");
 *
 * // Get multiple subjects for combined context
 * const [adapters, kysely] = getSubject("database-adapters", "kysely-adapter");
 * ```
 */
export function getSubject(...ids: string[]): Subject[] {
  // Order subjects deterministically according to the tree structure
  const orderedIds = orderSubjects(ids);
  return loadSubjects(orderedIds);
}

/**
 * Get all available subjects
 * @returns Array of all subjects with complete data
 */
export function getAllSubjects(): Subject[] {
  return loadAllSubjects();
}

// Re-export types
export type { Subject, SubjectInfo, Example, Section, CodeBlock } from "./parser.js";

// Re-export subject tree utilities
export {
  orderSubjects,
  getSubjectParent,
  getSubjectChildren,
  expandSubjectWithChildren,
  getAllSubjectIdsInOrder,
  isCategory,
  getCategoryTitle,
} from "./subject-tree.js";
