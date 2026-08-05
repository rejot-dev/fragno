import { z } from "zod";

export type AutomationExternalEntityRef<
  TSource extends string = string,
  TType extends string = string,
> = {
  scope: "external";
  source: TSource;
  type: TType;
  id: string;
};

export type AutomationEntityRef<TType extends string = string> =
  | {
      scope: "internal";
      type: TType;
      id: string;
    }
  | AutomationExternalEntityRef<string, TType>;

export type AutomationActorRole = "initiator" | "principal" | "delegate" | "assistant";

export type AutomationActor<TRole extends AutomationActorRole = AutomationActorRole> =
  AutomationEntityRef & {
    role: TRole;
  };

export type AutomationActors = Readonly<{
  initiator: AutomationActor<"initiator">;
  principal: AutomationActor<"principal"> | null;
  delegation: readonly (AutomationActor<"delegate"> | AutomationActor<"assistant">)[];
}>;

export const BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY = "__backofficeActors";

export type BackofficeWorkflowActorMetadata = {
  [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: AutomationActors;
};

const automationInternalEntitySchema = z.strictObject({
  scope: z.literal("internal"),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const automationExternalEntitySchema = z.strictObject({
  scope: z.literal("external"),
  source: z.string().trim().min(1),
  type: z.string().trim().min(1),
  id: z.string().trim().min(1),
});

const automationInitiatorActorSchema = z.discriminatedUnion("scope", [
  automationInternalEntitySchema.extend({ role: z.literal("initiator") }),
  automationExternalEntitySchema.extend({ role: z.literal("initiator") }),
]);

const automationPrincipalActorSchema = z.discriminatedUnion("scope", [
  automationInternalEntitySchema.extend({ role: z.literal("principal") }),
  automationExternalEntitySchema.extend({ role: z.literal("principal") }),
]);

const automationDelegateActorSchema = z.discriminatedUnion("scope", [
  automationInternalEntitySchema.extend({ role: z.literal("delegate") }),
  automationExternalEntitySchema.extend({ role: z.literal("delegate") }),
]);

const automationAssistantActorSchema = z.discriminatedUnion("scope", [
  automationInternalEntitySchema.extend({ role: z.literal("assistant") }),
  automationExternalEntitySchema.extend({ role: z.literal("assistant") }),
]);

export const automationEntityRefsEqual = (left: AutomationEntityRef, right: AutomationEntityRef) =>
  left.scope === right.scope &&
  left.type === right.type &&
  left.id === right.id &&
  (left.scope === "internal" || (right.scope === "external" && left.source === right.source));

export const automationActorsSchema: z.ZodType<AutomationActors> = z
  .strictObject({
    initiator: automationInitiatorActorSchema,
    principal: automationPrincipalActorSchema.nullable(),
    delegation: z.array(
      z.discriminatedUnion("role", [automationDelegateActorSchema, automationAssistantActorSchema]),
    ),
  })
  .superRefine((actors, context) => {
    const actorSequence = [
      actors.initiator,
      ...(actors.principal ? [actors.principal] : []),
      ...actors.delegation,
    ];

    const hasDuplicateIdentity = actorSequence.some((actor, actorIndex) =>
      actorSequence
        .slice(0, actorIndex)
        .some((previousActor) => automationEntityRefsEqual(previousActor, actor)),
    );

    if (hasDuplicateIdentity) {
      context.addIssue({
        code: "custom",
        message: "Automation actor provenance contains duplicate identities.",
      });
    }
  });

export const backofficeWorkflowActorMetadataSchema = z.strictObject({
  [BACKOFFICE_WORKFLOW_ACTORS_METADATA_KEY]: automationActorsSchema,
});

export const AUTOMATION_SYSTEM_INITIATOR = {
  scope: "internal",
  type: "system",
  id: "backoffice",
  role: "initiator",
} as const satisfies AutomationActors["initiator"];
