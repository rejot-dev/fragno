import { createRouteCaller } from "@fragno-dev/core/api";

import { isUniqueConstraintError, type HookContext } from "@fragno-dev/db";

import type {
  AutomationIdentityBindingRecord,
  AutomationsRuntime,
} from "../runtime-tools/families/automations";
import type { IdentityBindActorArgs, IdentityLookupBindingArgs } from "./commands/types";
import type { createAutomationFragment } from "./index";
import { automationFragmentSchema } from "./schema";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

export type { AutomationIdentityBindingRecord, AutomationsRuntime };

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
): Promise<AutomationIdentityBindingRecord | null> => {
  return await context
    .handlerTx()
    .retrieve(findIdentityBindingBySourceKey(source, key))
    .transformRetrieve(([binding]) => (binding?.status === "linked" ? binding : null))
    .execute();
};

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
        .transform(({ mutateResult }) => mutateResult)
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

export const createAutomationsRuntime = ({
  lookupBinding,
  bindActor,
}: AutomationsRuntime): AutomationsRuntime => ({
  lookupBinding,
  bindActor,
});

export const createStorageBackedAutomationsRuntime = ({
  hookContext,
}: {
  hookContext: AutomationIdentityStorageContext;
}): AutomationsRuntime =>
  createAutomationsRuntime({
    lookupBinding: async (args) => lookupAutomationIdentityBinding(hookContext, args),
    bindActor: async (args) => bindAutomationIdentityActor(hookContext, args),
  });

const createAutomationsRouteCaller = (env: CloudflareEnv, orgId: string) => {
  const automationsDo = env.AUTOMATIONS.get(env.AUTOMATIONS.idFromName(orgId));

  return createRouteCaller<AutomationFragment>({
    // Durable Object route helpers still need absolute URLs, so use a synthetic origin.
    baseUrl: "https://automations.do",
    mountRoute: "/api/automations/bindings",
    fetch: async (outboundRequest) => {
      const url = new URL(outboundRequest.url);
      url.searchParams.set("orgId", orgId);
      return automationsDo.fetch(new Request(url.toString(), outboundRequest));
    },
  });
};

export const createRouteBackedAutomationsRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): AutomationsRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Automation identity backend requires an organisation id");
  }

  const callRoute = createAutomationsRouteCaller(env, normalizedOrgId);

  return createAutomationsRuntime({
    lookupBinding: async ({ source, key }) => {
      const response = await callRoute("GET", "/identity-bindings/lookup", {
        query: { source, key },
      });

      if (response.type === "error" && response.status === 404) {
        return null;
      }

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(
          `Automations backend returned ${response.status}: ${response.error.message}`,
        );
      }

      throw new Error(`Automations backend returned ${response.status}`);
    },
    bindActor: async (args) => {
      const response = await callRoute("POST", "/identity-bindings/bind", {
        body: args,
      });

      if (response.type === "json") {
        return response.data;
      }

      if (response.type === "error") {
        throw new Error(
          `Automations backend returned ${response.status}: ${response.error.message}`,
        );
      }

      throw new Error(`Automations backend returned ${response.status}`);
    },
  });
};
