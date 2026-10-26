import type { AutomationSteward } from "@fragno-dev/backoffice-api/v0/automation";
import {
  automationEventDefinitionCreateInputSchema,
  automationEventDefinitionUpdateInputSchema,
  type AutomationEventDefinition,
  type AutomationEventDefinitionCreateInput,
  type AutomationEventDefinitionUpdateInput,
} from "@fragno-dev/backoffice-api/v0/events";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { listAutomationEventDescriptors } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

import {
  AutomationEventDefinitionValidationError,
  assertAutomationEventDefinitionSchemas,
  buildAutomationEventDefinitionId,
} from "./event-definitions";
import { automationFragmentSchema } from "./schema";
import { assertStewardWrite, MEMBERS_STEWARD, stewardsEqual } from "./stewards";

type AutomationEventDefinitionServiceContext = DatabaseServiceContext<Record<string, never>>;

type AutomationEventDefinitionRow = {
  id: { valueOf(): string };
  source: string;
  eventType: string;
  label: string;
  description: string | null;
  payloadSchema: AutomationEventDefinition["payloadSchema"] | null;
  actorSchema: AutomationEventDefinition["actorSchema"] | null;
  subjectSchema: AutomationEventDefinition["subjectSchema"] | null;
  example: unknown;
  enabled: boolean;
  steward: AutomationSteward | null;
  createdAt: Date;
  updatedAt: Date;
};

const isStaticAutomationEvent = (input: { source: string; eventType: string }) =>
  listAutomationEventDescriptors().some(
    (event) => event.source === input.source && event.eventType === input.eventType,
  );

function automationEventDefinitionFromRow(
  row: AutomationEventDefinitionRow,
): AutomationEventDefinition {
  return {
    id: row.id.valueOf(),
    source: row.source,
    eventType: row.eventType,
    label: row.label,
    description: row.description,
    payloadSchema: row.payloadSchema ?? null,
    actorSchema: row.actorSchema ?? null,
    subjectSchema: row.subjectSchema ?? null,
    example: row.example ?? null,
    enabled: row.enabled,
    capabilityId: "dynamic",
    steward: row.steward ?? MEMBERS_STEWARD,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What a definition means to events of its type; whether it is enabled is not part of it. */
function eventDefinitionContentEqual(
  left: Omit<AutomationEventDefinition, "id" | "capabilityId" | "steward" | "enabled">,
  right: Omit<AutomationEventDefinition, "id" | "capabilityId" | "steward" | "enabled">,
) {
  return (
    left.label === right.label &&
    (left.description ?? null) === (right.description ?? null) &&
    JSON.stringify(left.payloadSchema ?? null) === JSON.stringify(right.payloadSchema ?? null) &&
    JSON.stringify(left.actorSchema ?? null) === JSON.stringify(right.actorSchema ?? null) &&
    JSON.stringify(left.subjectSchema ?? null) === JSON.stringify(right.subjectSchema ?? null) &&
    JSON.stringify(left.example ?? null) === JSON.stringify(right.example ?? null)
  );
}

const describeEventDefinition = (input: { source: string; eventType: string }) =>
  `Event definition '${input.source}/${input.eventType}'`;

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
        .transformRetrieve(([definitions]) => definitions.map(automationEventDefinitionFromRow))
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
        .transformRetrieve(([definition]) =>
          definition ? automationEventDefinitionFromRow(definition) : null,
        )
        .build();
    },

    /** The writer becomes the definition's steward. */
    createEventDefinition(input: AutomationEventDefinitionCreateInput, writer: AutomationSteward) {
      const definition = automationEventDefinitionCreateInputSchema.parse(input);
      if (isStaticAutomationEvent(definition)) {
        throw new AutomationEventDefinitionValidationError(
          "Automation event definition source/type is reserved by a built-in catalog event.",
        );
      }
      assertAutomationEventDefinitionSchemas(definition);
      const id = buildAutomationEventDefinitionId(definition.source, definition.eventType);

      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }): AutomationEventDefinition => {
          const now = uow.now();
          const values = {
            source: definition.source,
            eventType: definition.eventType,
            label: definition.label,
            description: definition.description ?? null,
            payloadSchema: definition.payloadSchema ?? null,
            actorSchema: definition.actorSchema ?? null,
            subjectSchema: definition.subjectSchema ?? null,
            example: definition.example ?? null,
            enabled: definition.enabled,
            steward: writer,
          };
          uow.create("automation_event_definition", {
            id,
            ...values,
            createdAt: now,
            updatedAt: now,
          });
          return { id, ...values, capabilityId: "dynamic" };
        })
        .build();
    },

    /**
     * A package's write claims the definition, even an adopted one whose content already matches;
     * members' toggles keep its steward.
     */
    updateEventDefinition(input: AutomationEventDefinitionUpdateInput, writer: AutomationSteward) {
      const { source, eventType, patch } = automationEventDefinitionUpdateInputSchema.parse(input);
      const id = buildAutomationEventDefinitionId(source, eventType);

      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event_definition", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }): AutomationEventDefinition | null => {
          if (!existing) {
            return null;
          }

          const current = automationEventDefinitionFromRow(existing);
          const next = {
            ...current,
            label: patch.label ?? current.label,
            description: "description" in patch ? (patch.description ?? null) : current.description,
            payloadSchema:
              "payloadSchema" in patch ? (patch.payloadSchema ?? null) : current.payloadSchema,
            actorSchema: "actorSchema" in patch ? (patch.actorSchema ?? null) : current.actorSchema,
            subjectSchema:
              "subjectSchema" in patch ? (patch.subjectSchema ?? null) : current.subjectSchema,
            example: "example" in patch ? (patch.example ?? null) : current.example,
            enabled: patch.enabled ?? current.enabled,
          };
          const contentChanged = !eventDefinitionContentEqual(current, next);
          assertStewardWrite({
            resource: describeEventDefinition(current),
            steward: current.steward,
            // Install scripts never labelled the definitions they created.
            legacyListingId: null,
            writer,
            definitionChanged: contentChanged,
            toggleable: true,
          });
          if (contentChanged) {
            assertAutomationEventDefinitionSchemas(next);
          }
          const steward = contentChanged || writer.kind === "package" ? writer : current.steward;
          if (
            !contentChanged &&
            next.enabled === current.enabled &&
            stewardsEqual(steward, current.steward)
          ) {
            return current;
          }

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
                steward,
                updatedAt: uow.now(),
              })
              .check(),
          );
          // The update time is only known once the write commits.
          const { updatedAt: _previousUpdate, ...updated } = next;
          return { ...updated, steward };
        })
        .build();
    },

    /** Returns whether there was a definition to delete. */
    deleteEventDefinition(input: { source: string; eventType: string }, writer: AutomationSteward) {
      const id = buildAutomationEventDefinitionId(input.source, input.eventType);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("automation_event_definition", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", id)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return false;
          }
          assertStewardWrite({
            resource: describeEventDefinition(input),
            steward: existing.steward ?? MEMBERS_STEWARD,
            legacyListingId: null,
            writer,
            definitionChanged: true,
            toggleable: true,
          });
          uow.delete("automation_event_definition", existing.id, (b) => b.check());
          return true;
        })
        .build();
    },
  });
