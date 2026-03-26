import { createRouteCaller } from "@fragno-dev/core/api";

import type { HookContext } from "@fragno-dev/db";

import { createAutomationCommands } from "../automation/commands/bash-adapter";
import { AUTOMATIONS_COMMAND_SPEC_LIST } from "../automation/commands/registry";
import type {
  AutomationsCommandHandlers,
  IdentityBindActorArgs,
  IdentityLookupBindingArgs,
} from "../automation/commands/types";
import type { createAutomationFragment } from "../automation/index";
import { automationFragmentSchema } from "../automation/schema";
import type { BashCommandFactoryInput } from "./bash-host";

type AutomationFragment = ReturnType<typeof createAutomationFragment>;

export type AutomationIdentityBindingRecord = {
  id?: unknown;
  source: string;
  key: string;
  value: string;
  description?: string | null;
  status: string;
  linkedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type AutomationsBashRuntime = {
  lookupBinding: (
    input: IdentityLookupBindingArgs,
  ) => Promise<AutomationIdentityBindingRecord | null>;
  bindActor: (input: IdentityBindActorArgs) => Promise<AutomationIdentityBindingRecord>;
};

export type RegisteredAutomationsBashCommandContext = {
  runtime: AutomationsBashRuntime;
};

export type AutomationIdentityStorageContext = Pick<HookContext, "handlerTx">;

const automationsCommandHandlers: AutomationsCommandHandlers<RegisteredAutomationsBashCommandContext> =
  {
    "automations.identity.lookup-binding": async (command, context) => {
      const binding = await context.runtime.lookupBinding(command.args);
      if (!binding || binding.status !== "linked") {
        return {
          exitCode: 1,
        };
      }

      return {
        data: binding,
      };
    },
    "automations.identity.bind-actor": async (command, context) => {
      return {
        data: await context.runtime.bindActor(command.args),
      };
    },
  };

export const createAutomationsBashCommands = (input: BashCommandFactoryInput) => {
  const automationsContext = input.context.automations;
  if (!automationsContext) {
    return [];
  }

  return createAutomationCommands(
    AUTOMATIONS_COMMAND_SPEC_LIST,
    automationsCommandHandlers,
    automationsContext,
    input.commandCallsResult,
  );
};

const isDuplicateIdentityBindingError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const name = "name" in error ? String(error.name) : "";
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message).toLowerCase() : "";

  if (name === "UniqueConstraintError") {
    return true;
  }

  if (code === "SQLITE_CONSTRAINT" || code === "23505") {
    return message.includes("identity_binding") || message.includes("unique");
  }

  return message.includes("duplicate") || message.includes("unique constraint");
};

export const lookupAutomationIdentityBinding = async (
  context: AutomationIdentityStorageContext,
  { source, key }: IdentityLookupBindingArgs,
): Promise<AutomationIdentityBindingRecord | null> => {
  return await context
    .handlerTx()
    .retrieve(({ forSchema }) =>
      forSchema(automationFragmentSchema).findFirst("identity_binding", (b) =>
        b.whereIndex("idx_identity_binding_source_key", (eb) =>
          eb.and(eb("source", "=", source), eb("key", "=", key)),
        ),
      ),
    )
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
        .retrieve(({ forSchema }) =>
          forSchema(automationFragmentSchema).findFirst("identity_binding", (b) =>
            b.whereIndex("idx_identity_binding_source_key", (eb) =>
              eb.and(eb("source", "=", source), eb("key", "=", key)),
            ),
          ),
        )
        .mutate(({ forSchema, retrieveResult: [existing] }) => {
          const table = forSchema(automationFragmentSchema);
          const now = table.now();
          const descriptionValue =
            typeof description === "string"
              ? description.trim() !== ""
                ? description.trim()
                : null
              : existing && existing.description != null
                ? String(existing.description)
                : null;

          if (existing) {
            table.update("identity_binding", existing.id, (b) =>
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

          const createdId = table.create("identity_binding", {
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
      if (attempt === 0 && isDuplicateIdentityBindingError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to bind automation identity actor after retrying a concurrent insert.");
};

export const createAutomationsBashRuntime = ({
  lookupBinding,
  bindActor,
}: AutomationsBashRuntime): AutomationsBashRuntime => ({
  lookupBinding,
  bindActor,
});

export const createStorageBackedAutomationsBashRuntime = ({
  hookContext,
}: {
  hookContext: AutomationIdentityStorageContext;
}): AutomationsBashRuntime =>
  createAutomationsBashRuntime({
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

export const createRouteBackedAutomationsBashRuntime = ({
  env,
  orgId,
}: {
  env: CloudflareEnv;
  orgId: string;
}): AutomationsBashRuntime => {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Automation identity backend requires an organisation id");
  }

  const callRoute = createAutomationsRouteCaller(env, normalizedOrgId);

  return createAutomationsBashRuntime({
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
