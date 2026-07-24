import { z } from "zod";

export type AutomationEntityScope = "internal" | "external";

export type AutomationEntityRef<
  TScope extends AutomationEntityScope = AutomationEntityScope,
  TType extends string = string,
> = {
  scope: TScope;
  type: TType;
  id: string;
  source?: string;
};

export type AutomationExternalEntityRef<
  TSource extends string = string,
  TType extends string = string,
> = AutomationEntityRef<"external", TType> & {
  source: TSource;
};

export type AutomationActorRole = "initiator" | "principal" | "delegate" | "assistant";

export type AutomationActor<TRole extends AutomationActorRole = AutomationActorRole> =
  AutomationEntityRef & {
    role: TRole;
  };

export type AutomationInitiatorActor = AutomationActor<"initiator">;
export type AutomationPrincipalActor = AutomationActor<"principal">;
export type AutomationDelegatedActor = AutomationActor<"delegate"> | AutomationActor<"assistant">;

export type AutomationActors = Readonly<{
  initiator: AutomationInitiatorActor;
  principal: AutomationPrincipalActor | null;
  delegation: readonly AutomationDelegatedActor[];
}>;

const createAutomationActorSchema = <TRole extends AutomationActorRole>(role: TRole) =>
  z.discriminatedUnion("scope", [
    z.strictObject({
      scope: z.literal("internal"),
      type: z.string().trim().min(1),
      id: z.string().trim().min(1),
      role: z.literal(role),
    }),
    z.strictObject({
      scope: z.literal("external"),
      source: z.string().trim().min(1),
      type: z.string().trim().min(1),
      id: z.string().trim().min(1),
      role: z.literal(role),
    }),
  ]);

const haveSameAutomationActorIdentity = (left: AutomationEntityRef, right: AutomationEntityRef) =>
  left.scope === right.scope &&
  left.source === right.source &&
  left.type === right.type &&
  left.id === right.id;

export const automationActorsSchema: z.ZodType<AutomationActors> = z
  .strictObject({
    initiator: createAutomationActorSchema("initiator"),
    principal: createAutomationActorSchema("principal").nullable(),
    delegation: z.array(
      z.discriminatedUnion("role", [
        createAutomationActorSchema("delegate"),
        createAutomationActorSchema("assistant"),
      ]),
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
        .some((previousActor) => haveSameAutomationActorIdentity(previousActor, actor)),
    );

    if (hasDuplicateIdentity) {
      context.addIssue({
        code: "custom",
        message: "Automation actor provenance contains duplicate identities.",
      });
    }
  });

export const AUTOMATION_SYSTEM_INITIATOR = {
  scope: "internal",
  type: "system",
  id: "backoffice",
  role: "initiator",
} as const satisfies AutomationInitiatorActor;
