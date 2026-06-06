import { isUniqueConstraintError, type HookContext } from "@fragno-dev/db";

import type {
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
} from "../runtime-tools/automation-types";
import type {
  AutomationBindingsRuntime,
  AutomationIdentityBindingRecord,
} from "../runtime-tools/families/automations-bindings";
import { automationIdentityBindingRecordSchema } from "./identity";
import { automationFragmentSchema } from "./schema";

export type { AutomationBindingsRuntime, AutomationIdentityBindingRecord };

export type AutomationIdentityStorageContext = Pick<HookContext, "handlerTx">;

type AutomationIdentityRetrieveScope = Parameters<
  Parameters<ReturnType<AutomationIdentityStorageContext["handlerTx"]>["retrieve"]>[0]
>[0];

const findIdentityBindingBySourceKey =
  (source: string, key: string) =>
  ({ forSchema }: AutomationIdentityRetrieveScope) =>
    forSchema(automationFragmentSchema).findFirst("identity_binding", (b) =>
      b.whereIndex("idx_identity_binding_source_key", (eb) =>
        eb.and(eb("source", "=", source), eb("key", "=", key)),
      ),
    );

export const lookupAutomationIdentityBinding = async (
  context: AutomationIdentityStorageContext,
  { source, key }: IdentityLookupBindingArgs,
): Promise<AutomationIdentityBindingRecord | null> =>
  await context
    .handlerTx()
    .retrieve(findIdentityBindingBySourceKey(source, key))
    .transformRetrieve(([binding]) =>
      binding?.status === "linked" ? automationIdentityBindingRecordSchema.parse(binding) : null,
    )
    .execute();

export const bindAutomationIdentityActor = async (
  context: AutomationIdentityStorageContext,
  { source, key, value, description }: IdentityBindActorArgs,
): Promise<AutomationIdentityBindingRecord> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await context
        .handlerTx()
        .retrieve(findIdentityBindingBySourceKey(source, key))
        .mutate(({ forSchema, retrieveResult: [existing] }) => {
          const uow = forSchema(automationFragmentSchema);
          const now = uow.now();
          const descriptionValue =
            typeof description === "string"
              ? description.trim() !== ""
                ? description.trim()
                : null
              : existing && existing.description != null
                ? String(existing.description)
                : null;

          if (existing) {
            uow.update("identity_binding", existing.id, (b) =>
              b
                .set({
                  source,
                  key,
                  value,
                  description: descriptionValue,
                  status: "linked",
                  linkedAt: now,
                  updatedAt: now,
                })
                .check(),
            );

            return {
              ...existing,
              source,
              key,
              value,
              description: descriptionValue,
              status: "linked" as const,
              linkedAt: now,
              updatedAt: now,
            };
          }

          const createdId = uow.create("identity_binding", {
            source,
            key,
            value,
            description: descriptionValue,
            status: "linked",
            linkedAt: now,
            createdAt: now,
            updatedAt: now,
          });

          return {
            id: createdId.valueOf(),
            source,
            key,
            value,
            description: descriptionValue,
            status: "linked" as const,
            linkedAt: now,
            createdAt: now,
            updatedAt: now,
          };
        })
        .transform(({ mutateResult }) => automationIdentityBindingRecordSchema.parse(mutateResult))
        .execute();
    } catch (error) {
      if (attempt === 0 && isUniqueConstraintError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to bind automation identity actor after retrying a concurrent insert.");
};

export const createAutomationBindingsRuntime = ({
  lookupBinding,
  bindActor,
}: AutomationBindingsRuntime): AutomationBindingsRuntime => ({ lookupBinding, bindActor });

export const createStorageBackedAutomationBindingsRuntime = ({
  hookContext,
}: {
  hookContext: AutomationIdentityStorageContext;
}): AutomationBindingsRuntime =>
  createAutomationBindingsRuntime({
    lookupBinding: async (args) => lookupAutomationIdentityBinding(hookContext, args),
    bindActor: async (args) => bindAutomationIdentityActor(hookContext, args),
  });
