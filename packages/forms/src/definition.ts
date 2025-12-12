import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { formsSchema } from "./schema";
import type { FormsConfig } from ".";
import type { JSONSchema, NewForm, UpdateForm, FormStatus } from "./models";
import type { FragnoReference } from "@fragno-dev/db/schema";
import { createAjv, type JsonSchema } from "@jsonforms/core";

const ajv = createAjv({ allErrors: true });

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
  uiSchema: form.uiSchema as JSONSchema,
});

const asExternalResponse = <
  T extends { id: { externalId: string }; formId: FragnoReference; data: unknown },
>(
  response: T,
) => {
  const { formId, ...rest } = response;
  return {
    ...rest,
    id: response.id.externalId,
    data: response.data as Record<string, unknown>,
  };
};

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

        if (currentForms.length === 0) return { success: false };
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

      validateData: (schema: JsonSchema, data: Record<string, unknown>): ValidationResult => {
        const validator = ajv.compile(schema);
        const valid = validator(data);

        if (valid) {
          return { success: true, data: data as ValidatedData };
        }
        console.error("ERROR", JSON.stringify(validator.errors));
        return {
          success: false,
          // TODO: better error type for validation errors?
          error: {
            message: "Validation failed",
            errors: (validator.errors ?? []).map((e) => ({
              path: e.instancePath || "",
              message: e.message ?? "Invalid value",
            })),
          },
        };
      },

      createResponse: async (formId: string, formVersion: number, data: ValidatedData) => {
        return (
          await deps.db.create("response", {
            formId: formId,
            formVersion: formVersion,
            data,
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
