import type { AutomationEvent } from "@fragno-dev/backoffice-api/v0/events";
import {
  type BackofficeContextScope,
  type BackofficeProjectOwner,
  type BackofficeScopeIdNames,
  backofficeScopeRootOwner,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { DatabaseServiceContext } from "@fragno-dev/db";

import { nextNumberedSlug } from "@/lib/numbered-slug";

import { AUTOMATION_SYSTEM_INITIATOR } from "./actors";
import type { AutomationEventIngestionPayload, AutomationInternalHooks } from "./internal-hooks";
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

type AutomationProjectServiceContext = DatabaseServiceContext<AutomationInternalHooks>;

type AutomationProjectServicesOptions = {
  ownerScope: BackofficeContextScope;
};

type ProjectTimestampFields = {
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const buildProjectPayload = (
  project: {
    id: { valueOf(): string };
    slug: string;
    name: string;
    description: string | null;
    archivedAt: Date | null;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
  },
  timestamps: ProjectTimestampFields,
) => ({
  project: {
    id: project.id.valueOf(),
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
  ownerScope: BackofficeProjectOwner<BackofficeScopeIdNames>;
  eventType: "project.created" | "project.updated" | "project.archived";
  project: Parameters<typeof buildProjectPayload>[0];
  occurredAt: string;
  timestamps: ProjectTimestampFields;
}) => {
  const projectId = project.id.valueOf();
  const rootOwner = backofficeScopeRootOwner(ownerScope);
  const event: AutomationEvent = {
    id: crypto.randomUUID(),
    scopeRestriction: null,
    scope: ownerScope,
    source: "automations",
    eventType,
    occurredAt,
    payload: buildProjectPayload(project, timestamps),
    actors: {
      initiator: AUTOMATION_SYSTEM_INITIATOR,
      principal: null,
      delegation: [],
    },
    subject: {
      ...(rootOwner.kind === "org" ? { orgId: rootOwner.orgId } : { userId: rootOwner.userId }),
      projectId,
    },
    causation: { kind: "origin" },
  };

  uow.triggerHook(
    "internalIngestEvent",
    {
      event,
      reclassificationChain: [{ source: event.source, eventType: event.eventType }],
    },
    { id: event.id },
  );
};

/** This Automations object's scope cannot own projects. */
export class AutomationProjectOwnerRequiredError extends Error {
  constructor() {
    super("Projects are only stored by organization, user, and app Automations.");
    this.name = "AutomationProjectOwnerRequiredError";
  }
}

/** Projects are stored by the scope that owns them; system and project scopes own none. */
function requireProjectOwner(
  ownerScope: BackofficeContextScope,
): BackofficeProjectOwner<BackofficeScopeIdNames> {
  if (ownerScope.kind === "system" || ownerScope.kind === "project") {
    throw new AutomationProjectOwnerRequiredError();
  }
  return ownerScope;
}

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
            projectId: project.id.valueOf(),
            slug: project.slug,
            name: project.name,
          };
        })
        .build();
    },

    createProject(args: AutomationProjectCreateInput) {
      const ownerScope = requireProjectOwner(options.ownerScope);
      const input = automationProjectCreateInputSchema.parse(args);
      const slug = projectSlugSchema.parse(input.slug ?? slugFromProjectName(input.name));
      return this.serviceTx(automationFragmentSchema)
        .mutate(({ uow }) => {
          const now = new Date();
          const nowIso = now.toISOString();
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

          return {
            id: id.valueOf(),
            ...project,
          };
        })
        .build();
    },

    /**
     * Creates the project an app provisioned, once. The caller derives `projectId` from the app's
     * own identifier, so a repeated call finds the project it made, even after a rename.
     */
    provisionAppProject(args: { projectId: string; name: string; createdByUserId: string }) {
      const ownerScope = requireProjectOwner(options.ownerScope);
      // Leaves room for the number that makes the slug unique.
      const base = slugFromProjectName(args.name).slice(0, 72).replace(/-+$/, "") || "project";
      return this.serviceTx(automationFragmentSchema)
        .retrieve((uow) =>
          uow
            .findFirst("project", (b) =>
              b.whereIndex("primary", (eb) => eb("id", "=", args.projectId)),
            )
            .find("project", (b) =>
              b.whereIndex("idx_project_slug", (eb) => eb("slug", "starts with", base)),
            ),
        )
        .mutate(({ uow, retrieveResult: [existing, sharing] }) => {
          if (existing) {
            return { projectId: args.projectId, slug: existing.slug, created: false };
          }
          const now = new Date();
          const nowIso = now.toISOString();
          const project = {
            slug: nextNumberedSlug(
              base,
              sharing.map(({ slug }) => slug),
            ),
            name: args.name,
            description: null,
            archivedAt: null,
            createdByUserId: args.createdByUserId,
            createdAt: now,
            updatedAt: now,
          };
          const id = uow.create("project", { id: args.projectId, ...project });
          triggerProjectEvent({
            uow,
            ownerScope,
            eventType: "project.created",
            project: { id, ...project },
            occurredAt: nowIso,
            timestamps: { archivedAt: null, createdAt: nowIso, updatedAt: nowIso },
          });
          return { projectId: args.projectId, slug: project.slug, created: true };
        })
        .build();
    },

    updateProject(args: AutomationProjectUpdateInput) {
      const ownerScope = requireProjectOwner(options.ownerScope);
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
          const nowIso = now.toISOString();
          const next = {
            ...existing,
            ...(input.slug ? { slug: input.slug } : {}),
            ...(input.name ? { name: input.name } : {}),
            ...("description" in input ? { description: input.description ?? null } : {}),
            updatedAt: now,
          };
          const timestamps = {
            archivedAt: existing.archivedAt?.toISOString() ?? null,
            createdAt: existing.createdAt.toISOString(),
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

          triggerProjectEvent({
            uow,
            ownerScope,
            eventType: "project.updated",
            project: next,
            occurredAt: nowIso,
            timestamps,
          });

          return {
            ...next,
            id: existing.id.valueOf(),
          };
        })
        .build();
    },

    archiveProject(args: AutomationProjectArchiveInput) {
      const ownerScope = requireProjectOwner(options.ownerScope);
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
          const nowIso = now.toISOString();
          const archivedAt = existing.archivedAt ?? now;
          const archivedAtIso = existing.archivedAt?.toISOString() ?? nowIso;
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
            createdAt: existing.createdAt.toISOString(),
            updatedAt: nowIso,
          };

          triggerProjectEvent({
            uow,
            ownerScope,
            eventType: "project.archived",
            project: next,
            occurredAt: nowIso,
            timestamps,
          });

          return {
            ...next,
            id: existing.id.valueOf(),
          };
        })
        .build();
    },
  });
