import { defineRoutes } from "@fragno-dev/core";
import { z } from "zod";
import { formsFragmentDef } from "./definition";
import {
  FormSchema,
  NewFormSchema,
  NewFormResponseSchema,
  ResponseMetadataSchema,
  FormResponseSchema,
  UpdateFormSchema,
} from "./models";
import type { Form } from "./models";
import type { StaticForm } from ".";

/** Extract and validate request metadata from headers (untrusted input) */
function extractRequestMetadata(headers: Headers) {
  const rawUserAgent = headers.get("User-Agent");
  const rawIp =
    headers.get("CF-Connecting-IP") ||
    headers.get("X-Forwarded-For")?.split(",")[0].trim() ||
    headers.get("X-Real-IP") ||
    null;
  const result = ResponseMetadataSchema.safeParse({
    ip: rawIp,
    userAgent: rawUserAgent,
  });

  // Return validated data or null values if validation fails
  return result.success ? result.data : { ip: null, userAgent: null };
}

const staticAsRegularForm = (sf: StaticForm): Form => ({
  id: sf.id,
  title: sf.title,
  description: sf.description,
  slug: sf.slug,
  status: "static",
  dataSchema: sf.dataSchema,
  uiSchema: sf.uiSchema as unknown as Form["uiSchema"],
  version: sf.version,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Public routes
export const publicRoutes = defineRoutes(formsFragmentDef).create(
  ({ services, defineRoute, config }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/:slug",
        outputSchema: FormSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          // Check static forms first
          const staticForm = config.staticForms?.find((f) => f.slug === pathParams.slug);
          if (staticForm) {
            return json(staticAsRegularForm(staticForm));
          }

          const form = await this.handlerTx()
            .withServiceCalls(() => [services.getFormBySlug(pathParams.slug)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!form) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }

          return json(form);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/:slug/submit",
        inputSchema: NewFormResponseSchema,
        outputSchema: z.string(),
        errorCodes: ["NOT_FOUND", "VALIDATION_ERROR", "FORM_NOT_OPEN"] as const,
        handler: async function ({ input, pathParams, headers }, { json, error }) {
          const { data } = await input.valid();

          // Check static forms first
          const staticFormConfig = config.staticForms?.find((f) => f.slug === pathParams.slug);
          const form = staticFormConfig
            ? staticAsRegularForm(staticFormConfig)
            : await this.handlerTx()
                .withServiceCalls(() => [services.getFormBySlug(pathParams.slug)] as const)
                .transform(({ serviceResult: [result] }) => result)
                .execute();

          if (!form) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }

          // Static forms and open forms accept submissions
          if (form.status !== "open" && form.status !== "static") {
            return error(
              { message: "Form is not open, has status " + form.status, code: "FORM_NOT_OPEN" },
              400,
            );
          }

          // Form validation
          const result = services.validateData(form.dataSchema, data);

          if (!result.success) {
            const message = result.error.errors.map((e) => e.message).join(" ");
            return error({ message, code: "VALIDATION_ERROR" }, 400);
          }

          // Extract and validate request metadata from headers
          const metadata = extractRequestMetadata(headers);

          const responseId = await this.handlerTx()
            .withServiceCalls(
              () =>
                [services.createResponse(form.id, form.version, result.data, metadata)] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          if (config.onResponseSubmitted) {
            await config.onResponseSubmitted({
              id: responseId,
              formId: form.id,
              formVersion: form.version,
              data,
              submittedAt: new Date(),
              ip: metadata?.ip,
              userAgent: metadata?.userAgent,
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
        handler: async function (_ctx, { json }) {
          const dbForms = await this.handlerTx()
            .withServiceCalls(() => [services.listForms()] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          const staticForms = (config.staticForms ?? []).map(staticAsRegularForm);
          return json([...staticForms, ...dbForms]);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/admin/forms/:id",
        outputSchema: FormSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          // Check static forms first
          const staticForm = config.staticForms?.find((f) => f.id === pathParams.id);
          if (staticForm) {
            return json(staticAsRegularForm(staticForm));
          }

          const form = await this.handlerTx()
            .withServiceCalls(() => [services.getForm(pathParams.id)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!form) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }

          return json(form);
        },
      }),

      defineRoute({
        method: "POST",
        path: "/admin/forms",
        inputSchema: NewFormSchema,
        outputSchema: z.string(),
        errorCodes: ["CREATE_FAILED", "INVALID_JSON_SCHEMA"] as const,
        handler: async function ({ input }, { json, error }) {
          const data = await input.valid();

          // Validate that dataSchema is valid JSON Schema
          try {
            z.fromJSONSchema(data.dataSchema);
          } catch (e) {
            const message = e instanceof Error ? e.message : "Invalid JSON Schema";
            return error({ message, code: "INVALID_JSON_SCHEMA" }, 400);
          }

          const formId = await this.handlerTx()
            .withServiceCalls(() => [services.createForm(data)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (config.onFormCreated) {
            await config.onFormCreated({ ...data, id: formId });
          }
          return json(formId);
        },
      }),

      defineRoute({
        method: "PUT",
        path: "/admin/forms/:id",
        inputSchema: UpdateFormSchema,
        errorCodes: ["NOT_FOUND", "STATIC_FORM_READ_ONLY", "INVALID_JSON_SCHEMA"] as const,
        handler: async function ({ input, pathParams }, { json, error }) {
          const isStatic = config.staticForms?.some((f) => f.id === pathParams.id);
          if (isStatic) {
            return error(
              { message: "Static forms cannot be modified", code: "STATIC_FORM_READ_ONLY" },
              403,
            );
          }
          const data = await input.valid();

          // Validate that dataSchema is valid JSON Schema (if provided)
          if (data.dataSchema) {
            try {
              z.fromJSONSchema(data.dataSchema);
            } catch (e) {
              const message = e instanceof Error ? e.message : "Invalid JSON Schema";
              return error({ message, code: "INVALID_JSON_SCHEMA" }, 400);
            }
          }

          const { success } = await this.handlerTx()
            .withServiceCalls(() => [services.updateForm(pathParams.id, data)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!success) {
            return error({ message: "Form not found", code: "NOT_FOUND" }, 404);
          }
          return json(true);
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/admin/forms/:id",
        errorCodes: ["NOT_FOUND", "STATIC_FORM_READ_ONLY"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          const isStatic = config.staticForms?.some((f) => f.id === pathParams.id);
          if (isStatic) {
            return error(
              { message: "Static forms cannot be deleted", code: "STATIC_FORM_READ_ONLY" },
              403,
            );
          }
          await this.handlerTx()
            .withServiceCalls(() => [services.deleteForm(pathParams.id)] as const)
            .execute();
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
        outputSchema: z.array(FormResponseSchema),
        handler: async function ({ pathParams, query }, { json }) {
          const sortOrder = query.get("sortOrder") === "asc" ? "asc" : "desc";
          const responses = await this.handlerTx()
            .withServiceCalls(
              () =>
                [
                  services.listResponses(pathParams.id, {
                    field: "submittedAt",
                    order: sortOrder,
                  }),
                ] as const,
            )
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          return json(responses);
        },
      }),

      defineRoute({
        method: "GET",
        path: "/admin/submissions/:id",
        outputSchema: FormResponseSchema,
        errorCodes: ["NOT_FOUND"] as const,
        handler: async function ({ pathParams }, { json, error }) {
          const response = await this.handlerTx()
            .withServiceCalls(() => [services.getResponse(pathParams.id)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();
          if (!response) {
            return error({ message: "Submission not found", code: "NOT_FOUND" }, 404);
          }
          return json(response);
        },
      }),

      defineRoute({
        method: "DELETE",
        path: "/admin/submissions/:id",
        errorCodes: ["NOT_FOUND"] as const,
        handler: async function ({ pathParams }, { json }) {
          await this.handlerTx()
            .withServiceCalls(() => [services.deleteResponse(pathParams.id)] as const)
            .execute();
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
