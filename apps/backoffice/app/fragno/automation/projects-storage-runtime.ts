import type { DatabaseServiceContext } from "@fragno-dev/db";

import type { BackofficeContextScope } from "@/backoffice-runtime/context";

import { AUTOMATION_SYSTEM_ACTOR, type AutomationEvent } from "./contracts";
import {
  automationProjectArchiveInputSchema,
  automationProjectCreateInputSchema,
  automationProjectListInputSchema,
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

type AutomationProjectServiceContext = DatabaseServiceContext<{
  internalIngestEvent: (payload: AutomationEvent) => Promise<void> | void;
}>;

type AutomationProjectServicesOptions = {
  ownerScope: BackofficeContextScope;
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
          const now = new Date();
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

          const projectId = id.toString();
          const event: AutomationEvent = {
            id: `project.created:${ownerScope.orgId}:${projectId}`,
            scope: ownerScope,
            source: "automations",
            eventType: "project.created",
            occurredAt: now.toISOString(),
            payload: { project: { ...created, id: projectId } },
            actor: AUTOMATION_SYSTEM_ACTOR,
            actors: [AUTOMATION_SYSTEM_ACTOR],
            subject: {
              orgId: ownerScope.orgId,
              projectId,
            },
          };

          uow.triggerHook("internalIngestEvent", event, {
            id: event.id,
          });

          return created;
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

          const now = new Date();
          const next = {
            ...existing,
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...("description" in input ? { description: input.description ?? null } : {}),
            updatedAt: now,
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

          return next;
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

          const now = new Date();
          const archivedAt = existing.archivedAt ?? now;
          uow.update("project", existing.id, (b) =>
            b
              .set({
                archivedAt,
                updatedAt: now,
              })
              .check(),
          );

          return {
            ...existing,
            archivedAt,
            updatedAt: now,
          };
        })
        .build();
    },
  });
