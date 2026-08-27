// forms tools
type FormsCodemodeProvider = {
  /** List forms stored in the global system Forms integration. */
  listForms(input: FormsListFormsInput): Promise<FormsListFormsOutput>;
  /** Create a schema-backed form in the global system Forms integration. */
  createForm(input: FormsCreateFormInput): Promise<FormsCreateFormOutput>;
  /** Update a schema-backed form in the global system Forms integration. */
  updateForm(input: FormsUpdateFormInput): Promise<FormsUpdateFormOutput>;
  /** List responses submitted to a system form. */
  listSubmissions(input: FormsListSubmissionsInput): Promise<FormsListSubmissionsOutput>;
};
declare const forms: FormsCodemodeProvider;

type FormsListFormsInput = Record<string, unknown>;
type FormsListFormsOutput = {
  forms: {
    id: string;
    title: string;
    description?: string | null;
    slug: string;
    status: "draft" | "open" | "closed" | "static";
    dataSchema: {
      [key: string]: unknown;
    };
    uiSchema: {
      [key: string]: unknown;
    } | null;
    version: number;
    /** ISO 8601 datetime string. */
    createdAt: string;
    /** ISO 8601 datetime string. */
    updatedAt: string;
  }[];
};
type FormsCreateFormInput = {
  title: string;
  slug: string;
  description?: string | null;
  status?: "draft" | "open" | "closed";
  dataSchema: {
    [key: string]: unknown;
  };
  uiSchema?: {
    [key: string]: unknown;
  };
};
type FormsCreateFormOutput = {
  id: string;
};
type FormsUpdateFormInput = {
  title?: string;
  slug?: string;
  description?: string | null;
  status?: "draft" | "open" | "closed";
  dataSchema?: {
    [key: string]: unknown;
  };
  uiSchema?: {
    [key: string]: unknown;
  };
  formId: string;
};
type FormsUpdateFormOutput = {
  updated: true;
};
type FormsListSubmissionsInput = {
  formId: string;
  sortOrder?: "asc" | "desc";
  pageSize?: number;
  cursor?: string | null;
};
type FormsListSubmissionsOutput = {
  submissions: {
    id: string;
    formId: string | null;
    formVersion: number;
    data: {
      [key: string]: unknown;
    };
    /** ISO 8601 datetime string. */
    submittedAt: string;
    ip: string | null;
    userAgent: string | null;
  }[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
