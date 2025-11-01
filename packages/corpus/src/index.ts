import {
  getAvailableSubjectIds,
  loadSubject,
  loadSubjects,
  loadAllSubjects,
  type SubjectInfo,
  type Subject,
} from "./parser";

/**
 * Get basic information about all available subjects
 * @returns Array of subject info (id and title)
 */
export function getSubjects(): SubjectInfo[] {
  const ids = getAvailableSubjectIds();
  return ids.map((id) => {
    const subject = loadSubject(id);
    return {
      id: subject.id,
      title: subject.title,
    };
  });
}

/**
 * Get one or more subjects by their IDs
 * @param ids Subject IDs to load
 * @returns Array of complete subject data
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
  return loadSubjects(ids);
}

/**
 * Get all available subjects
 * @returns Array of all subjects with complete data
 */
export function getAllSubjects(): Subject[] {
  return loadAllSubjects();
}

// Re-export types
export type { Subject, SubjectInfo, Example, Section } from "./parser.js";
