import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "./contracts";
import type { AutomationEventIngestionPayload, AutomationInternalHooks } from "./internal-hooks";
import {
  automationProjectArchiveInputSchema,
  automationProjectCreateInputSchema,
  automationProjectListInputSchema,
  automationProjectSchema,
  automationProjectLookupInputSchema,
  automationProjectUpdateInputSchema,
  projectSlugSchema,
  slugFromProjectName,
  type AutomationProjectArchiveInput,
  type AutomationProjectCreateInput,
  type AutomationProjectListInput,
  type AutomationProjectExecutionTarget,
  type AutomationProjectLookupInput,
  type AutomationProjectUpdateInput,
} from "./projects";
import { automationFragmentSchema } from "./schema";
import {
  automationTimestampToDate,
  automationTimestampToIsoString,
  type AutomationTimestampInput,
} from "./timestamps";

type AutomationProjectServiceContext = DatabaseServiceContext<AutomationInternalHooks>;

type AutomationProjectServicesOptions = {
  ownerScope: BackofficeContextScope;
};

const projectIdValue = (id: unknown): string => {
  if (typeof id === "object" && id && "externalId" in id) {
    return String((id as { externalId: unknown }).externalId);
  }
  return String(id);
};

type ProjectTimestampFields = {
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const materializeProjectDates = <TProject extends object>(
  project: TProject,
  timestamps: ProjectTimestampFields,
) => ({
  ...project,
  archivedAt: timestamps.archivedAt ? automationTimestampToDate(timestamps.archivedAt) : null,
  createdAt: automationTimestampToDate(timestamps.createdAt),
  updatedAt: automationTimestampToDate(timestamps.updatedAt),
});

const buildProjectPayload = (
  project: {
    id: unknown;
    slug: string;
    name: string;
    description: string | null;
    archivedAt: AutomationTimestampInput | null;
    createdByUserId: string;
    createdAt: AutomationTimestampInput;
    updatedAt: AutomationTimestampInput;
  },
  timestamps: ProjectTimestampFields,
) => ({
  project: {
    id: projectIdValue(project.id),
    slug: project.slug,
    name: project.name,
    description: project.description,
    archivedAt: timestamps.archivedAt,
    createdByUserId: project.createdByUserId,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
});

type ProjectEventUnitOfWork = {
  triggerHook(
    hookName: "internalIngestEvent",
    payload: AutomationEventIngestionPayload,
    options: { id: string },
  ): void;
};

const triggerProjectEvent = ({
  uow,
  ownerScope,
  eventType,
  project,
  occurredAt,
  timestamps,
}: {
  uow: ProjectEventUnitOfWork;
  ownerScope: Extract<BackofficeContextScope, { kind: "org" }>;
  eventType: "project.created" | "project.updated" | "project.archived";
  project: Parameters<typeof buildProjectPayload>[0];
  occurredAt: string;
  timestamps: ProjectTimestampFields;
}) => {
  const projectId = projectIdValue(project.id);
  const event: AutomationEvent = {
    id: crypto.randomUUID(),
    scope: ownerScope,
    source: "automations",
    eventType,
    occurredAt,
    payload: buildProjectPayload(project, timestamps),
    actor: AUTOMATION_SYSTEM_ACTOR,
    actors: [AUTOMATION_SYSTEM_ACTOR],
    subject: {
      orgId: ownerScope.orgId,
      projectId,
    },
  };

  uow.triggerHook("internalIngestEvent", { event }, { id: event.id });
};

export const createAutomationProjectServices = (
  defineService: <TService>(
    service: TService & ThisType<AutomationProjectServiceContext>,
  ) => TService,
  options: AutomationProjectServicesOptions,
) =>
  defineService({
    listProjects(args: AutomationProjectListInput = {}) {
      const input = automationProjectListInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.find("project", (b) => {
            const query = b.whereIndex("idx_project_slug");
            return input.limit ? query.pageSize(input.limit) : query;
          }),
        )
        .transformRetrieve(([projects]) => projects)
        .build();
    },

    getProject(args: AutomationProjectLookupInput) {
      const input = automationProjectLookupInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => {
          if (input.projectId) {
            return uow.findFirst("project", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.projectId!)),
            );
          }

          return uow.findFirst("project", (b) =>
            b.whereIndex("idx_project_slug", (eb) => eb("slug", "=", input.slug!)),
          );
        })
        .transformRetrieve(([project]) => project ?? null)
        .build();
    },

    resolveProjectForExecution(args: AutomationProjectLookupInput) {
      const input = automationProjectLookupInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) => {
          if (input.projectId) {
            return uow.findFirst("project", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", input.projectId!)),
            );
          }

          return uow.findFirst("project", (b) =>
            b.whereIndex("idx_project_slug", (eb) => eb("slug", "=", input.slug!)),
          );
        })
        .transformRetrieve(([project]): AutomationProjectExecutionTarget | null => {
          if (!project || project.archivedAt) {
            return null;
          }

          return {
            projectId: String(project.id),
            slug: project.slug,
            name: project.name,
          };
        })
        .build();
    },

    createProject(args: AutomationProjectCreateInput) {
      if (options.ownerScope?.kind !== "org") {
        throw new Error("Projects can only be created in org-scoped Automations.");
      }

      const ownerScope = options.ownerScope;
      const input = automationProjectCreateInputSchema.parse(args);
      const slug = projectSlugSchema.parse(input.slug ?? slugFromProjectName(input.name));
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = uow.now();
          const nowIso = automationTimestampToIsoString(now);
          const project = {
            slug,
            name: input.name,
            description: input.description ?? null,
            archivedAt: null,
            createdByUserId: input.createdByUserId,
            createdAt: now,
            updatedAt: now,
          };
          const id = uow.create("project", project);
          const created = { id, ...project };
          const timestamps = {
            archivedAt: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          };

          triggerProjectEvent({
            uow,
            ownerScope,
            eventType: "project.created",
            project: created,
            occurredAt: nowIso,
            timestamps,
          });

          return automationProjectSchema.parse(materializeProjectDates(created, timestamps));
        })
        .build();
    },

    updateProject(args: AutomationProjectUpdateInput) {
      const input = automationProjectUpdateInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("project", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.projectId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return null;
          }

          const now = uow.now();
          const nowIso = automationTimestampToIsoString(now);
          const next = {
            ...existing,
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...("description" in input ? { description: input.description ?? null } : {}),
            updatedAt: now,
          };
          const timestamps = {
            archivedAt: existing.archivedAt
              ? automationTimestampToIsoString(existing.archivedAt)
              : null,
            createdAt: automationTimestampToIsoString(existing.createdAt),
            updatedAt: nowIso,
          };

          uow.update("project", existing.id, (b) =>
            b
              .set({
                slug: next.slug,
                name: next.name,
                description: next.description,
                updatedAt: now,
              })
              .check(),
          );

          if (options.ownerScope.kind !== "org") {
            throw new Error("Projects can only be updated in org-scoped Automations.");
          }

          triggerProjectEvent({
            uow,
            ownerScope: options.ownerScope,
            eventType: "project.updated",
            project: next,
            occurredAt: nowIso,
            timestamps,
          });

          return automationProjectSchema.parse(materializeProjectDates(next, timestamps));
        })
        .build();
    },

    archiveProject(args: AutomationProjectArchiveInput) {
      const input = automationProjectArchiveInputSchema.parse(args);
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow.findFirst("project", (b) =>
            b.whereIndex("primary", (eb) => eb("id", "=", input.projectId)),
          ),
        )
        .mutate(({ uow, retrieveResult: [existing] }) => {
          if (!existing) {
            return null;
          }

          const now = uow.now();
          const nowIso = automationTimestampToIsoString(now);
          const archivedAt = existing.archivedAt ?? now;
          const archivedAtIso = existing.archivedAt
            ? automationTimestampToIsoString(existing.archivedAt)
            : nowIso;
          uow.update("project", existing.id, (b) =>
            b
              .set({
                archivedAt,
                updatedAt: now,
              })
              .check(),
          );

          const next = {
            ...existing,
            archivedAt,
            updatedAt: now,
          };
          const timestamps = {
            archivedAt: archivedAtIso,
            createdAt: automationTimestampToIsoString(existing.createdAt),
            updatedAt: nowIso,
          };

          if (options.ownerScope.kind !== "org") {
            throw new Error("Projects can only be archived in org-scoped Automations.");
          }

          triggerProjectEvent({
            uow,
            ownerScope: options.ownerScope,
            eventType: "project.archived",
            project: next,
            occurredAt: nowIso,
            timestamps,
          });

          return automationProjectSchema.parse(materializeProjectDates(next, timestamps));
        })
        .build();
    },
  });
