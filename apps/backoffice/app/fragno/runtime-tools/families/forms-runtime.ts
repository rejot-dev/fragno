import { createRouteCaller, type RouteCallerForFragment } from "@fragno-dev/core/api";

import type { Form, FormSubmissionsPage, NewForm, UpdateForm } from "@fragno-dev/forms";

import type { FormsObject } from "@/backoffice-runtime/object-registry";
import type { FormsFragment } from "@/fragno/forms";

import { isSuccessStatus, throwOnRouteRuntimeError } from "../runtime-errors";

/** Bounded submission page requested from the system Forms runtime. */
export type ListFormSubmissionsInput = {
  formId: string;
  sortOrder: "asc" | "desc";
  pageSize: number;
  cursor: string | null;
};

export type FormsRuntime = {
  listForms(): Promise<Form[]>;
  createForm(input: NewForm): Promise<{ id: string }>;
  updateForm(formId: string, input: UpdateForm): Promise<{ updated: true }>;
  listSubmissions(input: ListFormSubmissionsInput): Promise<FormSubmissionsPage>;
};

function createFormsRouteCaller(object: FormsObject): RouteCallerForFragment<FormsFragment> {
  return createRouteCaller<FormsFragment>({
    baseUrl: "https://forms.do",
    mountRoute: "/api/forms",
    fetch: object.fetch.bind(object),
  });
}

/** Creates system Forms operations backed by the singleton Forms Durable Object routes. */
export function createFormsRuntime(object: FormsObject): FormsRuntime {
  const callRoute = createFormsRouteCaller(object);

  return {
    listForms: async () => {
      const response = await callRoute("GET", "/admin/forms");
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Forms fragment",
        label: "forms.list",
      });
    },
    createForm: async (input) => {
      const response = await callRoute("POST", "/admin/forms", { body: input });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return { id: response.data };
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Forms fragment",
        label: "forms.create",
      });
    },
    updateForm: async (formId, input) => {
      const response = await callRoute("PUT", "/admin/forms/:id", {
        pathParams: { id: formId },
        body: input,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return { updated: true };
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Forms fragment",
        label: "forms.update",
      });
    },
    listSubmissions: async (input) => {
      const query = new URLSearchParams({
        sortOrder: input.sortOrder,
        pageSize: String(input.pageSize),
      });
      if (input.cursor !== null) {
        query.set("cursor", input.cursor);
      }
      const response = await callRoute("GET", "/admin/forms/:id/submissions", {
        pathParams: { id: input.formId },
        query,
      });
      if (response.type === "json" && isSuccessStatus(response.status)) {
        return response.data;
      }
      return throwOnRouteRuntimeError(response, {
        runtimeLabel: "Forms fragment",
        label: "forms.submissions.list",
      });
    },
  };
}
