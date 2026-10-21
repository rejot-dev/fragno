// projects tools
type ProjectsCodemodeProvider = {
  /** Create a project in the selected organization or personal scope as the current user. Select the owner scope, not a project, app workspace, or System. Omit slug to derive it from the name; slugs must be unique within the owner. */
  create(input: ProjectsCreateInput): Promise<ProjectsCreateOutput>;
  /** List projects in the selected organization or personal scope, ordered by slug, including archived projects. Select the owner scope, not a project, app workspace, or System. Resume with nextCursor and the same pageSize. */
  list(input: ProjectsListInput): Promise<ProjectsListOutput>;
};
declare const projects: ProjectsCodemodeProvider;

type ProjectCreateInput = {
  name: string;
  slug?: string | null;
  description?: string | null;
};
type ProjectCreateResult = {
  projectId: string;
  slug: string;
};
type DirectoryPageInput = {
  pageSize?: number;
  cursor?: string | null;
};
type ProjectPage = {
  projects: ProjectRecord[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type ProjectRecord = {
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  createdByUserId: string;
  /** ISO 8601 datetime string. */
  createdAt: string;
  /** ISO 8601 datetime string. */
  updatedAt: string;
};
type ProjectsCreateInput = ProjectCreateInput;
type ProjectsCreateOutput = ProjectCreateResult;
type ProjectsListInput = DirectoryPageInput;
type ProjectsListOutput = ProjectPage;
