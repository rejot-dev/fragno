import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { formsSchema } from "./schema";
import type { FormsConfig } from ".";
import type { JSONSchema, NewForm, UpdateForm, FormStatus, UIElementSchema } from "./models";
import { Validator, type Schema } from "@cfworker/json-schema";

export type ValidatedData<T = Record<string, unknown>> = T;
export type ValidationResult =
  | { success: true; data: ValidatedData }
  | {
      success: false;
      error: { message: string; errors: Array<{ path: string; message: string }> };
    };

// External to this fragment
const asExternalForm = <
  T extends { id: { externalId: string }; status: string; dataSchema: unknown; uiSchema: unknown },
>(
  form: T,
) => ({
  ...form,
  id: form.id.externalId,
  status: form.status as FormStatus,
  dataSchema: form.dataSchema as JSONSchema,
  uiSchema: form.uiSchema as UIElementSchema,
});

const asExternalResponse = <
  T extends {
    id: { externalId: string };
    formId: string | null;
    data: unknown;
    ip: string | null;
    userAgent: string | null;
  },
>(
  response: T,
) => ({
  ...response,
  id: response.id.externalId,
  data: response.data as Record<string, unknown>,
});

export interface SubmissionSortOptions {
  field: "submittedAt";
  order: "asc" | "desc";
}

export const formsFragmentDef = defineFragment<FormsConfig>("forms")
  .extend(withDatabase(formsSchema))
  .withDependencies(({ db }) => ({ db }))
  .providesBaseService(({ deps }) => {
    return {
      createForm: async (input: NewForm) => {
        return (await deps.db.create("form", input)).externalId;
      },

      getForm: async (id: string) => {
        const form = await deps.db.findFirst("form", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", id)),
        );
        return form ? asExternalForm(form) : null;
      },

      getFormBySlug: async (slug: string) => {
        const form = await deps.db.findFirst("form", (b) =>
          b.whereIndex("idx_form_slug", (eb) => eb("slug", "=", slug)),
        );
        return form ? asExternalForm(form) : null;
      },

      updateForm: async (id: string, input: UpdateForm) => {
        const uow = deps.db
          .createUnitOfWork()
          .find("form", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));

        const [currentForms] = await uow.executeRetrieve();

        if (currentForms.length === 0) {
          return { success: false };
        }
        // TODO: length > 1 ?

        const currentForm = currentForms[0];

        // Only increment version if changing data schema
        const newVersion = input.dataSchema ? currentForm.version + 1 : currentForm.version;

        uow.update("form", currentForm.id, (b) => {
          b.set({ ...input, version: newVersion, updatedAt: new Date() }).check();
        });
        return uow.executeMutations();
      },

      listForms: async () => {
        const forms = await deps.db.find("form", (b) => b.whereIndex("primary"));
        return forms.map(asExternalForm);
      },

      deleteForm: async (id: string) => {
        await deps.db.delete("form", id);
      },

      validateData: (schema: Schema, data: Record<string, unknown>): ValidationResult => {
        const validator = new Validator(schema);
        const result = validator.validate(data);

        if (result.valid) {
          return { success: true, data: data as ValidatedData };
        }
        console.error("ERROR", JSON.stringify(result.errors));
        return {
          success: false,
          // TODO: better error type for validation errors?
          // see: https://jsonforms.io/docs/validation/#external-validation-errors
          error: {
            message: "Validation failed",
            errors: result.errors.map((e) => ({
              path: e.instanceLocation || "",
              message: e.error ?? "Invalid value",
            })),
          },
        };
      },

      createResponse: async (
        formId: string,
        formVersion: number,
        data: ValidatedData,
        metadata?: { ip?: string | null; userAgent?: string | null },
      ) => {
        return (
          await deps.db.create("response", {
            formId,
            formVersion,
            data,
            ip: metadata?.ip ?? null,
            userAgent: metadata?.userAgent ?? null,
          })
        ).externalId;
      },

      getResponse: async (id: string) => {
        const response = await deps.db.findFirst("response", (b) =>
          b.whereIndex("primary", (eb) => eb("id", "=", id)),
        );
        return response ? asExternalResponse(response) : null;
      },

      listResponses: async (
        formId: string,
        sort: SubmissionSortOptions = { field: "submittedAt", order: "desc" },
      ) => {
        const responses = await deps.db.find("response", (b) =>
          b
            .whereIndex("idx_response_form", (eb) => eb("formId", "=", formId))
            .orderByIndex("idx_response_submitted_at", sort.order),
        );
        return responses.map(asExternalResponse);
      },

      deleteResponse: async (id: string) => {
        return await deps.db.delete("response", id);
      },
    };
  })
  .build();
