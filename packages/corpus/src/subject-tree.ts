/**
 * Subject tree structure defining relationships and ordering
 */

export interface SubjectNode {
  id: string;
  children?: string[];
}

/**
 * Tree structure defining subject hierarchy and ordering
 * - Root-level subjects are listed in order
 * - Children are indented under their parents
 */
const SUBJECT_TREE: SubjectNode[] = [
  { id: "defining-routes" },
  { id: "fragment-services" },
  { id: "fragment-instantiation" },
  { id: "database-querying" },
  {
    id: "database-adapters",
    children: ["kysely-adapter", "drizzle-adapter"],
  },
];

/**
 * Flattened map of all subjects and their parent relationships
 */
const SUBJECT_PARENT_MAP = new Map<string, string | null>();
const SUBJECT_ORDER_MAP = new Map<string, number>();

// Build the parent and order maps
let orderIndex = 0;
for (const node of SUBJECT_TREE) {
  SUBJECT_PARENT_MAP.set(node.id, null);
  SUBJECT_ORDER_MAP.set(node.id, orderIndex++);

  if (node.children) {
    for (const childId of node.children) {
      SUBJECT_PARENT_MAP.set(childId, node.id);
      SUBJECT_ORDER_MAP.set(childId, orderIndex++);
    }
  }
}

/**
 * Gets the parent of a subject, or null if it's a root subject
 */
export function getSubjectParent(subjectId: string): string | null {
  return SUBJECT_PARENT_MAP.get(subjectId) ?? null;
}

/**
 * Gets the children of a subject
 */
export function getSubjectChildren(subjectId: string): string[] {
  const node = SUBJECT_TREE.find((n) => n.id === subjectId);
  return node?.children ?? [];
}

/**
 * Orders an array of subject IDs according to the tree structure
 * This ensures deterministic ordering regardless of input order
 */
export function orderSubjects(subjectIds: string[]): string[] {
  return [...subjectIds].sort((a, b) => {
    const orderA = SUBJECT_ORDER_MAP.get(a) ?? Number.MAX_SAFE_INTEGER;
    const orderB = SUBJECT_ORDER_MAP.get(b) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
}

/**
 * Expands a subject ID to include its children if it has any
 * Useful for when a user requests a parent topic and wants to see all related content
 */
export function expandSubjectWithChildren(subjectId: string): string[] {
  const children = getSubjectChildren(subjectId);
  if (children.length > 0) {
    return [subjectId, ...children];
  }
  return [subjectId];
}

/**
 * Gets all subject IDs in tree order
 */
export function getAllSubjectIdsInOrder(): string[] {
  const ids: string[] = [];
  for (const node of SUBJECT_TREE) {
    ids.push(node.id);
    if (node.children) {
      ids.push(...node.children);
    }
  }
  return ids;
}
