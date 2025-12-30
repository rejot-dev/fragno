import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { publicRoutes, adminRoutes } from "./routes";
import { formsFragmentDef } from "./definition";
import type { Form, JSONSchema, FormResponse } from "./models";
import type { UISchemaElement } from "@jsonforms/core";

// Forms that exist in code, but submissions are stored in the DB
// Static forms always have status: "static" and accept submissions
export interface StaticForm {
  id: string;
  title: string;
  description?: string;
  slug: string;
  dataSchema: JSONSchema;
  uiSchema?: UISchemaElement;
  version: number;
}

export interface FormsConfig {
  onFormCreated?: (form: Omit<Form, "version" | "createdAt" | "updatedAt">) => Promise<void>;
  onResponseSubmitted?: (response: FormResponse) => Promise<void>;
  staticForms?: StaticForm[];
}

export const routes = [publicRoutes, adminRoutes] as const;

export function createFormsFragment(
  config: FormsConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(formsFragmentDef)
    .withConfig(config)
    .withRoutes(routes)
    .withOptions(options)
    .build();
}

export function createFormsClients(fragnoConfig: FragnoPublicClientConfig) {
  const b = createClientBuilder(formsFragmentDef, fragnoConfig, routes);

  return {
    // Public
    useForm: b.createHook("/:slug"),
    useSubmitForm: b.createMutator("POST", "/:slug/submit"),

    // Admin - Forms
    useForms: b.createHook("/admin/forms"),
    useCreateForm: b.createMutator("POST", "/admin/forms"),
    useUpdateForm: b.createMutator("PUT", "/admin/forms/:id"),
    useDeleteForm: b.createMutator("DELETE", "/admin/forms/:id"),

    // Admin - Submissions
    useSubmissions: b.createHook("/admin/forms/:id/submissions"),
    useSubmission: b.createHook("/admin/submissions/:id"),
    useDeleteSubmission: b.createMutator("DELETE", "/admin/submissions/:id"),
  };
}

export { formsFragmentDef } from "./definition";
export type { SubmissionSortOptions } from "./definition";
export type { FragnoRouteConfig } from "@fragno-dev/core";
export type {
  NewForm,
  UpdateForm,
  Form,
  NewFormResponse,
  FormResponse,
  FormResponseMetadata,
  FormStatus,
} from "./models";
