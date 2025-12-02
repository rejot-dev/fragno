import { defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import { formsFragmentDef } from "./definition";
import {
  FormSchema,
  NewFormSchema,
  NewResponseSchema,
  ResponseSchema,
  UpdateFormSchema,
} from "./models";

// Public routes
export const publicRoutes = defineRoutes(formsFragmentDef).create(
  ({ services, defineRoute, config }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/:id",
        outputSchema: FormSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async ({ pathParams }, { json, error }) => {
          const form = await services.getForm(pathParams.id);
          if (!form) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }
          return json(form);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/:id/submit",
        inputSchema: z.object({ data: z.record(z.string(), z.unknown()) }),
        outputSchema: v.responseOutputSchema,
        errorCodes: ["NOT_FOUND", "NOT_PUBLISHED"] as const,
        handler: async ({ input, pathParams }, { json, error }) => {
          const { data } = await input.valid();
          const formId = pathParams.id;

          const form = await services.getForm(formId);
          if (!form || form.status !== "open") {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }

          // TODO: Validate data against form.dataSchema using @jsonforms/core
          const response = await services.submitResponse(formId, data);
          if (!response) {
            return error({ message: "Failed to submit response", code: "NOT_FOUND" }, 500);
          }

          return json(responseId);
        },
      }),
    ];
  },
);

// Admin routes
export const adminRoutes = defineRoutes(formsFragmentDef).create(
  ({ services, defineRoute, config }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/admin/forms",
        outputSchema: z.array(FormSchema),
        handler: async (_ctx, { json }) => {
          const forms = await services.listForms();
          return json(forms);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/admin/forms",
        inputSchema: NewFormSchema,
        outputSchema: z.string(),
        errorCodes: ["CREATE_FAILED"] as const,
        handler: async ({ input }, { json }) => {
          const data = await input.valid();
          const formId = await services.createForm(data);
          config.onFormCreated?.({ ...data, id: formId });
          return json(formId);
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/admin/forms/:id",
        inputSchema: UpdateFormSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async ({ input, pathParams }, { json, error }) => {
          const data = await input.valid();
          const { success } = await services.updateForm(pathParams.id, data);
          if (!success) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }
          return json(success);
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/admin/forms/:id",
        errorCodes: ["NOT_FOUND"] as const,
        handler: async ({ pathParams }, { json }) => {
          await services.deleteForm(pathParams.id);
          // TODO: 404 when form not found
          // if (!deleted) {
          //   return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          // }
          return json(true);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/admin/forms/:id/submissions",
        outputSchema: z.array(ResponseSchema),
        handler: async ({ pathParams }, { json }) => {
          const responses = await services.listResponses(pathParams.id);
          return json(responses.map((r) => ({ ...r, formId: pathParams.id })));
        },
      }),

      defineRoute({
        method: "GET",
        path: "/admin/submissions/:id",
        outputSchema: ResponseSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async ({ pathParams }, { json, error }) => {
          const response = await services.getResponse(pathParams.id);
          if (!response) {
            return error({ message: "Submission not found", code: "NOT_FOUND" }, 404);
          }
          return json({ ...response, formId: pathParams.id });
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/admin/submissions/:id",
        errorCodes: ["NOT_FOUND"] as const,
        handler: async ({ pathParams }, { json }) => {
          await services.deleteResponse(pathParams.id);
          // TODO: 404 when response not found
          // if (!deleted) {
          //   return error({ message: "Submission not found", code: "NOT_FOUND" }, 404);
          // }
          return json(true);
        },
      }),
    ];
  },
);
