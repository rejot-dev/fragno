import { createClientBuilder } from "@fragno-dev/core/client";
import type { FragnoPublicClientConfig } from "@fragno-dev/core/client";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";
import { instantiate } from "@fragno-dev/core";
import { publicRoutes, adminRoutes } from "./routes";
import { formsFragmentDef } from "./definition";
import type { Form, Response } from "./models";

export interface FormsConfig {
  onFormCreated?: (form: Omit<Form, "version" | "createdAt" | "updatedAt">) => void;
  onResponseSubmitted?: (response: Response) => void;
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
    useForm: b.createHook("/:id"),
    useSubmitForm: b.createMutator("POST", "/:id/submit"),

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
export type { FragnoRouteConfig } from "@fragno-dev/core";
