import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { z } from "zod";
import { formsSchema } from "./schema";
import type { FormsConfig } from ".";
import type { JSONSchema, NewForm, UpdateForm, FormStatus, UIElementSchema } from "./models";

export type ValidatedData<T = Record<string, unknown>> = T;
export type ValidationResult =
  | { success: true; data: ValidatedData }
  | {
      success: false;
      error: { message: string; errors: Array<{ instancePath: string; message: string }> };
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
  .providesBaseService(({ defineService }) =>
    defineService({
      createForm: function (input: NewForm) {
        return this.serviceTx(formsSchema)
          .mutate(({ uow }) => uow.create("form", input))
          .transform(({ mutateResult }) => mutateResult.externalId)
          .build();
      },

      getForm: function (id: string) {
        return this.serviceTx(formsSchema)
          .retrieve((uow) =>
            uow.findFirst("form", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .transformRetrieve(([form]) => (form ? asExternalForm(form) : null))
          .build();
      },

      getFormBySlug: function (slug: string) {
        return this.serviceTx(formsSchema)
          .retrieve((uow) =>
            uow.findFirst("form", (b) =>
              b.whereIndex("idx_form_slug", (eb) => eb("slug", "=", slug)),
            ),
          )
          .transformRetrieve(([form]) => (form ? asExternalForm(form) : null))
          .build();
      },

      updateForm: function (id: string, input: UpdateForm) {
        return this.serviceTx(formsSchema)
          .retrieve((uow) =>
            uow.find("form", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .mutate(({ uow, retrieveResult: [currentForms] }) => {
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

            return { success: true };
          })
          .build();
      },

      listForms: function () {
        return this.serviceTx(formsSchema)
          .retrieve((uow) => uow.find("form", (b) => b.whereIndex("primary")))
          .transformRetrieve(([forms]) => forms.map(asExternalForm))
          .build();
      },

      deleteForm: function (id: string) {
        return this.serviceTx(formsSchema)
          .mutate(({ uow }) => uow.delete("form", id))
          .build();
      },

      validateData: (schema: JSONSchema, data: Record<string, unknown>): ValidationResult => {
        const zodSchema = z.fromJSONSchema(schema);
        const result = zodSchema.safeParse(data);

        if (result.success) {
          return { success: true, data: result.data as ValidatedData };
        }
        return {
          success: false,

          error: {
            message: "Validation failed",
            errors: result.error.issues.map((e) => ({
              instancePath: "/" + e.path.join("/"),
              message: e.message,
            })),
          },
        };
      },

      createResponse: function (
        formId: string,
        formVersion: number,
        data: ValidatedData,
        metadata?: { ip?: string | null; userAgent?: string | null },
      ) {
        return this.serviceTx(formsSchema)
          .mutate(({ uow }) =>
            uow.create("response", {
              formId,
              formVersion,
              data,
              ip: metadata?.ip ?? null,
              userAgent: metadata?.userAgent ?? null,
            }),
          )
          .transform(({ mutateResult }) => mutateResult.externalId)
          .build();
      },

      getResponse: function (id: string) {
        return this.serviceTx(formsSchema)
          .retrieve((uow) =>
            uow.findFirst("response", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .transformRetrieve(([response]) => (response ? asExternalResponse(response) : null))
          .build();
      },

      listResponses: function (
        formId: string,
        sort: SubmissionSortOptions = { field: "submittedAt", order: "desc" },
      ) {
        return this.serviceTx(formsSchema)
          .retrieve((uow) =>
            uow.find("response", (b) =>
              b
                .whereIndex("idx_response_form", (eb) => eb("formId", "=", formId))
                .orderByIndex("idx_response_submitted_at", sort.order),
            ),
          )
          .transformRetrieve(([responses]) => responses.map(asExternalResponse))
          .build();
      },

      deleteResponse: function (id: string) {
        return this.serviceTx(formsSchema)
          .mutate(({ uow }) => uow.delete("response", id))
          .build();
      },
    }),
  )
  .build();
