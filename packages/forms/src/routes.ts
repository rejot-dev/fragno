import { defineRoutes } from "@fragno-dev/core";
import type { JsonSchema } from "@jsonforms/core";
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
        path: "/:slug",
        outputSchema: FormSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async ({ pathParams }, { json, error }) => {
          const form = await services.getFormBySlug(pathParams.slug);
          if (!form) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }

          return json(form);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/:slug/submit",
        inputSchema: NewResponseSchema,
        outputSchema: z.string(),
        errorCodes: ["NOT_FOUND", "VALIDATION_ERROR", "FORM_NOT_OPEN"] as const,
        handler: async ({ input, pathParams }, { json, error }) => {
          const { data } = await input.valid();

          const form = await services.getFormBySlug(pathParams.slug);
          if (!form) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }

          if (form.status !== "open") {
            return error(
              { message: "Form is not open, has status " + form.status, code: "FORM_NOT_OPEN" },
              400,
            );
          }

          // Form validation
          const result = services.validateData(form.dataSchema as JsonSchema, data);

          if (!result.success) {
            const message = result.error.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
            return error(
              { message: `Validation failed: ${message}`, code: "VALIDATION_ERROR" },
              400,
            );
          }

          const responseId = await services.createResponse(form.id, form.version, result.data);

          if (config.onResponseSubmitted) {
            // Use "RETURNING" insert instead?
            config.onResponseSubmitted({
              id: responseId,
              formId: form.id,
              formVersion: form.version,
              data,
              submittedAt: new Date(),
            });
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
        queryParameters: ["sortOrder"] as const,
        outputSchema: z.array(ResponseSchema),
        handler: async ({ pathParams, query }, { json }) => {
          const sortOrder = query.get("sortOrder") === "asc" ? "asc" : "desc";
          const responses = await services.listResponses(pathParams.id, {
            field: "submittedAt",
            order: sortOrder,
          });
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
