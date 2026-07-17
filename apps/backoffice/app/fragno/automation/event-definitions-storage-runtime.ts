import type { DatabaseServiceContext } from "@fragno-dev/db";

import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import {
  AutomationEventDefinitionValidationError,
  assertAutomationEventDefinitionSchemas,
  automationEventDefinitionCreateInputSchema,
  automationEventDefinitionUpdateInputSchema,
  buildAutomationEventDefinitionId,
  type AutomationEventDefinitionCreateInput,
  type AutomationEventDefinitionUpdateInput,
} from "./event-definitions";
import { automationFragmentSchema } from "./schema";

type AutomationEventDefinitionServiceContext = DatabaseServiceContext<Record<string, never>>;

const isStaticAutomationEvent = (input: { source: string; eventType: string }) =>
  listAutomationEventDescriptors().some(
    (event) => event.source === input.source && event.eventType === input.eventType,
  );

export const createAutomationEventDefinitionServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationEventDefinitionServiceContext>,
  ) => TService,
) =>
  defineService({
    listEventDefinitions() {
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("automation_event_definition", (b) =>
            b
              .whereIndex("primary")
              .orderByIndex("idx_automation_event_definition_source_type", "asc"),
          ),
        )
        .transformRetrieve(([definitions]) => definitions)
        .build();
    },

    getEventDefinition(input: { source: string; eventType: string }) {
      const id = buildAutomationEventDefinitionId(input.source, input.eventType);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event_definition", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .transformRetrieve(([definition]) => definition ?? null)
        .build();
    },

    createEventDefinition(input: AutomationEventDefinitionCreateInput) {
      const definition = automationEventDefinitionCreateInputSchema.parse(input);
      if (isStaticAutomationEvent(definition)) {
        throw new AutomationEventDefinitionValidationError(
          "Automation event definition source/type is reserved by a built-in catalog event.",
        );
      }
      assertAutomationEventDefinitionSchemas(definition);
      const id = buildAutomationEventDefinitionId(definition.source, definition.eventType);

      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          uow.create("automation_event_definition", {
            id,
            source: definition.source,
            eventType: definition.eventType,
            label: definition.label,
            description: definition.description ?? null,
            payloadSchema: definition.payloadSchema ?? null,
            actorSchema: definition.actorSchema ?? null,
            subjectSchema: definition.subjectSchema ?? null,
            example: definition.example ?? null,
            enabled: definition.enabled,
            createdAt: now,
            updatedAt: now,
          });

          return {
            id,
            ...definition,
            description: definition.description ?? null,
            payloadSchema: definition.payloadSchema ?? null,
            actorSchema: definition.actorSchema ?? null,
            subjectSchema: definition.subjectSchema ?? null,
            example: definition.example ?? null,
            capabilityId: "dynamic",
          };
        })
        .build();
    },

    updateEventDefinition(input: AutomationEventDefinitionUpdateInput) {
      const { source, eventType, patch } = automationEventDefinitionUpdateInputSchema.parse(input);
      const id = buildAutomationEventDefinitionId(source, eventType);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event_definition", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return null;
          }

          const next = {
            source: existing.source,
            eventType: existing.eventType,
            label: patch.label ?? existing.label,
            description:
              "description" in patch ? (patch.description ?? null) : existing.description,
            payloadSchema:
              "payloadSchema" in patch
                ? (patch.payloadSchema ?? null)
                : (existing.payloadSchema ?? null),
            actorSchema:
              "actorSchema" in patch ? (patch.actorSchema ?? null) : (existing.actorSchema ?? null),
            subjectSchema:
              "subjectSchema" in patch
                ? (patch.subjectSchema ?? null)
                : (existing.subjectSchema ?? null),
            example: "example" in patch ? (patch.example ?? null) : (existing.example ?? null),
            enabled: patch.enabled ?? existing.enabled,
          };
          assertAutomationEventDefinitionSchemas(next);

          const updatedAt = uow.now();
          uow.update("automation_event_definition", existing.id, (b) =>
            b
              .set({
                label: next.label,
                description: next.description,
                payloadSchema: next.payloadSchema,
                actorSchema: next.actorSchema,
                subjectSchema: next.subjectSchema,
                example: next.example,
                enabled: next.enabled,
                updatedAt,
              })
              .check(),
          );

          return {
            id: existing.id.valueOf(),
            ...next,
            capabilityId: "dynamic",
          };
        })
        .build();
    },
  });
