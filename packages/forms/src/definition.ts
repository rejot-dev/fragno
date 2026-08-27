import { z } from "zod";

import { defineFragment } from "@fragno-dev/core";
import { withDatabase, type Cursor, type HookFn } from "@fragno-dev/db";

import type { FormsConfig } from ".";
import type {
  Form,
  FormCreatedHookPayload,
  FormDeletedHookPayload,
  FormResponseSubmittedHookPayload,
  JSONSchema,
  StoredFormHookPayload,
  NewForm,
  UpdateForm,
  FormStatus,
  UIElementSchema,
} from "./models";
import { formsSchema, FORM_RESPONSE_PAGINATION_INDEX_NAME } from "./schema";

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

/** Cursor pagination options for reading submissions in stable submitted-at order. */
export interface SubmissionListOptions {
  sortOrder: "asc" | "desc";
  pageSize: number;
  cursor: Cursor | null;
}

type FormsHooksMap = {
  onFormCreated: HookFn<FormCreatedHookPayload>;
  onFormUpdated: HookFn<StoredFormHookPayload>;
  onFormDeleted: HookFn<FormDeletedHookPayload>;
  onResponseSubmitted: HookFn<FormResponseSubmittedHookPayload>;
};

function serializeStoredFormHookPayload(form: Form): StoredFormHookPayload {
  return {
    ...form,
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString(),
  };
}

export const formsFragmentDef = defineFragment<FormsConfig>("forms")
  .extend(withDatabase(formsSchema))
  .provideHooks<FormsHooksMap>(({ defineHook, config }) => ({
    onFormCreated: defineHook(async function (payload) {
      await config.onFormCreated?.(payload, this);
    }),
    onFormUpdated: defineHook(async function (payload) {
      await config.onFormUpdated?.(payload, this);
    }),
    onFormDeleted: defineHook(async function (payload) {
      await config.onFormDeleted?.(payload, this);
    }),
    onResponseSubmitted: defineHook(async function (payload) {
      await config.onResponseSubmitted?.(payload, this);
    }),
  }))
  .providesBaseService(({ defineService }) =>
    defineService({
      createForm: function (input: NewForm) {
        return this.serviceTx(formsSchema)
          .mutate(({ uow }) => {
            const createdAt = new Date();
            const formId = uow.create("form", {
              ...input,
              createdAt,
              updatedAt: createdAt,
            });
            uow.triggerHook("onFormCreated", {
              ...input,
              id: formId.externalId,
              createdAt: createdAt.toISOString(),
            });
            return formId;
          })
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
            const updatedAt = new Date();
            const updatedForm = asExternalForm({
              ...currentForm,
              ...input,
              version: newVersion,
              updatedAt,
            });

            uow.update("form", currentForm.id, (b) => {
              b.set({ ...input, version: newVersion, updatedAt }).check();
            });
            uow.triggerHook("onFormUpdated", serializeStoredFormHookPayload(updatedForm));

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
          .retrieve((uow) =>
            uow.findFirst("form", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id))),
          )
          .mutate(({ uow, retrieveResult: [currentForm] }) => {
            if (!currentForm) {
              return { success: false };
            }

            const deletedAt = new Date();
            uow.delete("form", currentForm.id);
            uow.triggerHook("onFormDeleted", {
              ...serializeStoredFormHookPayload(asExternalForm(currentForm)),
              deletedAt: deletedAt.toISOString(),
            });
            return { success: true };
          })
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
          .mutate(({ uow }) => {
            const submittedAt = new Date();
            const responseId = uow.create("response", {
              formId,
              formVersion,
              data,
              submittedAt,
              ip: metadata?.ip ?? null,
              userAgent: metadata?.userAgent ?? null,
            });
            uow.triggerHook("onResponseSubmitted", {
              id: responseId.externalId,
              formId,
              formVersion,
              data,
              submittedAt: submittedAt.toISOString(),
              ip: metadata?.ip ?? null,
              userAgent: metadata?.userAgent ?? null,
            });
            return responseId;
          })
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

      listResponses: function (formId: string, options: SubmissionListOptions) {
        const effectivePageSize = options.cursor?.pageSize ?? options.pageSize;
        const effectiveSortOrder = options.cursor?.orderDirection ?? options.sortOrder;

        return this.serviceTx(formsSchema)
          .retrieve((uow) =>
            uow.findWithCursor("response", (b) => {
              const query = b
                .whereIndex(FORM_RESPONSE_PAGINATION_INDEX_NAME, (eb) => eb("formId", "=", formId))
                .orderByIndex(FORM_RESPONSE_PAGINATION_INDEX_NAME, effectiveSortOrder)
                .pageSize(effectivePageSize);

              return options.cursor ? query.after(options.cursor) : query;
            }),
          )
          .transformRetrieve(([responses]) => ({
            submissions: responses.items.map(asExternalResponse),
            cursor: responses.cursor,
            hasNextPage: responses.hasNextPage,
          }))
          .build();
      },

      deleteResponse: function (id: string) {
        return this.serviceTx(formsSchema)
          .mutate(({ uow }) => {
            uow.delete("response", id);
          })
          .build();
      },
    }),
  )
  .build();
