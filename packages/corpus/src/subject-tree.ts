/**
 * Subject tree structure defining relationships and ordering
 */

export interface SubjectNode {
  id: string;
  children?: SubjectNode[];
  /** If true, this is a category node without a markdown file */
  category?: boolean;
}

/**
 * Tree structure defining subject hierarchy and ordering
 * - Root-level subjects are listed in order
 * - Children can be arbitrarily nested
 * - Organized by audience: users, fragment authors, and general topics
 */
const SUBJECT_TREE: SubjectNode[] = [
  {
    id: "for-users",
    category: true,
    children: [{ id: "fragment-instantiation" }, { id: "client-state-management" }],
  },
  {
    id: "for-fragment-authors",
    category: true,
    children: [
      { id: "defining-routes" },
      { id: "fragment-services" },
      { id: "database-querying" },
      {
        id: "database-adapters",
        children: [{ id: "kysely-adapter" }, { id: "drizzle-adapter" }],
      },
    ],
  },
  {
    id: "general",
    category: true,
    children: [],
  },
];

/**
 * Flattened map of all subjects and their parent relationships
 */
const SUBJECT_PARENT_MAP = new Map<string, string | null>();
const SUBJECT_ORDER_MAP = new Map<string, number>();
const SUBJECT_CHILDREN_MAP = new Map<string, string[]>();
const SUBJECT_CATEGORY_MAP = new Map<string, boolean>();

/**
 * Recursively processes a node and its children, building parent/order/category maps
 */
function processNode(node: SubjectNode, parent: string | null, orderIndexRef: { value: number }) {
  SUBJECT_PARENT_MAP.set(node.id, parent);
  SUBJECT_ORDER_MAP.set(node.id, orderIndexRef.value++);

  if (node.category) {
    SUBJECT_CATEGORY_MAP.set(node.id, true);
  }

  if (node.children) {
    const childIds = node.children.map((child) => child.id);
    SUBJECT_CHILDREN_MAP.set(node.id, childIds);

    for (const childNode of node.children) {
      processNode(childNode, node.id, orderIndexRef);
    }
  }
}

// Build the parent and order maps
const orderIndexRef = { value: 0 };
for (const node of SUBJECT_TREE) {
  processNode(node, null, orderIndexRef);
}

/**
 * Gets the parent of a subject, or null if it's a root subject
 */
export function getSubjectParent(subjectId: string): string | null {
  return SUBJECT_PARENT_MAP.get(subjectId) ?? null;
}

/**
 * Gets the direct children of a subject
 */
export function getSubjectChildren(subjectId: string): string[] {
  return SUBJECT_CHILDREN_MAP.get(subjectId) ?? [];
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
 * Expands a subject ID to include all its descendants recursively
 * Useful for when a user requests a parent topic and wants to see all related content
 */
export function expandSubjectWithChildren(subjectId: string): string[] {
  const result: string[] = [subjectId];

  function collectDescendants(id: string) {
    const children = SUBJECT_CHILDREN_MAP.get(id);
    if (children) {
      for (const childId of children) {
        result.push(childId);
        collectDescendants(childId);
      }
    }
  }

  collectDescendants(subjectId);
  return result;
}

/**
 * Gets all subject IDs in tree order (depth-first traversal)
 */
export function getAllSubjectIdsInOrder(): string[] {
  const ids: string[] = [];

  function traverse(node: SubjectNode) {
    ids.push(node.id);
    if (node.children) {
      for (const childNode of node.children) {
        traverse(childNode);
      }
    }
  }

  for (const node of SUBJECT_TREE) {
    traverse(node);
  }

  return ids;
}

/**
 * Checks if a subject ID is a category (has no markdown file)
 */
export function isCategory(subjectId: string): boolean {
  return SUBJECT_CATEGORY_MAP.get(subjectId) ?? false;
}

/**
 * Gets the category title for display purposes
 */
export function getCategoryTitle(categoryId: string): string {
  const titles: Record<string, string> = {
    "for-users": "For Users",
    "for-fragment-authors": "For Fragment Authors",
    general: "General",
  };
  return titles[categoryId] ?? categoryId;
}
