import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";
import { formsSchema } from "./schema";
import type { FormsConfig } from ".";
import type { JSONSchema, NewForm, UpdateForm, FormStatus } from "./models";
import type { FragnoReference } from "@fragno-dev/db/schema";

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

      updateForm: async (id: string, input: UpdateForm) => {
        const uow = deps.db
          .createUnitOfWork()
          .find("form", (b) => b.whereIndex("primary", (eb) => eb("id", "=", id)));

        const [currentForms] = await uow.executeRetrieve();

        if (currentForms.length === 0) return { success: false };

        const currentForm = currentForms[0];
        uow.update("form", currentForm.id, (b) => {
          b.set({ ...input, version: currentForm.version + 1, updatedAt: new Date() }).check();
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

      createResponseUnvalidated: async (
        formId: string,
        formVersion: number,
        data: Record<string, unknown>,
      ) => {
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

      listResponses: async (formId: string) => {
        const responses = await deps.db.find("response", (b) =>
          b.whereIndex("idx_response_form", (eb) => eb("formId", "=", formId)),
        );
        return responses.map(asExternalResponse);
      },

      deleteResponse: async (id: string) => {
        return await deps.db.delete("response", id);
      },
    };
  })
  .build();
