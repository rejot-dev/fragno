import {
  automationEntityRefsEqual,
  type AutomationActors,
} from "@fragno-dev/backoffice-api/v0/automation";
import {
  backofficeContextScopesEqual,
  backofficeScopeContains,
  isBackofficeRoutableScope,
  backofficeWorkspaceOrganization,
} from "@fragno-dev/backoffice-api/v0/shared/scope";

import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import {
  backofficeExecutionScopeRestriction,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { isBackofficeUnavailableError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  isBackofficeObjectAvailableInContext,
  type CodemodeCommands,
} from "@/backoffice-runtime/object-registry";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import {
  resolveAutomationScriptPath,
  type AutomationSourceReader,
} from "@/fragno/automation/automation-source";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import { createRouteBackedDurableHooksRuntime } from "@/fragno/automation/durable-hooks-route-runtime";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import { createRouteBackedAutomationIdentityRuntime } from "@/fragno/automation/external-identities-route-runtime";
import { readBackofficeAutomationSource } from "@/fragno/automation/read-backoffice-automation-source";
import { createRouteBackedAutomationRouterRuntime } from "@/fragno/automation/routing-route-runtime";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import { usageBillingForScope } from "@/fragno/billing/usage-billing";
import type { CodemodeRun, CodemodeRunContext } from "@/fragno/codemode/codemode-fragment";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import {
  createBackofficeSystemStateBackend,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { readSavedWorkflowProgram } from "@/fragno/codemode/workflow-program";
import {
  createPiManagerRuntime,
  type PiManagerRuntime,
} from "@/fragno/pi/manager/pi-manager-runtime";
import { createAccountRuntime } from "@/fragno/runtime-tools/families/account-runtime";
import { createAdminRuntime } from "@/fragno/runtime-tools/families/admin-runtime";
import { createAppsRuntime } from "@/fragno/runtime-tools/families/apps-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createCloudflareRuntime } from "@/fragno/runtime-tools/families/cloudflare-runtime";
import { createEventCatalogRuntime } from "@/fragno/runtime-tools/families/event-catalog";
import {
  createEventRuntime,
  type EventEmitter,
} from "@/fragno/runtime-tools/families/event-runtime";
import { createFormsRuntime } from "@/fragno/runtime-tools/families/forms-runtime";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import {
  createJavaScriptRuntime,
  type JavaScriptRunHistory,
} from "@/fragno/runtime-tools/families/javascript-runtime";
import { createMarketplaceRuntime } from "@/fragno/runtime-tools/families/marketplace-runtime";
import { createOrganizationRuntime } from "@/fragno/runtime-tools/families/organization-runtime";
import {
  createOtpRuntime,
  createUnavailableOtpRuntime,
} from "@/fragno/runtime-tools/families/otp-runtime";
import { createPackagesRuntime } from "@/fragno/runtime-tools/families/packages-runtime";
import { createProjectsRuntime } from "@/fragno/runtime-tools/families/projects-runtime";
import { createReson8Runtime } from "@/fragno/runtime-tools/families/reson8-runtime";
import { createSandboxRuntime } from "@/fragno/runtime-tools/families/sandbox-runtime";
import { createWebRuntime } from "@/fragno/runtime-tools/families/web-runtime";
import { createFileLinkRuntime } from "@/fragno/runtime-tools/file-links-runtime";

import type { InteractiveRuntimeToolContext } from "./bash-host";
import { buildJavaScriptModuleFile } from "./families/javascript-build";
import { resolveRuntimeOrganization } from "./runtime-public-scope";
import { runtimeToolFamilies } from "./tool-families";

export type RouteBackedRuntimeContextOptions = {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  /** Who the events emitted here, and in its scoped contexts, record as their cause. */
  emitter: EventEmitter;
  emittedEventActors?: AutomationActors;
  /** Fixes the source of events emitted here; see `CreateEventRuntimeOptions`. */
  emittedEventSource?: string;
  pi?:
    | { runtime: PiManagerRuntime }
    | ((execution: BackofficeExecutionContext) => { runtime: PiManagerRuntime })
    | null;
  workflowSourceReader?: AutomationSourceReader;
};

const unavailableMessage = (family: string, execution: BackofficeExecutionContext) =>
  `${family} is not available in ${execution.scope.kind} context.`;

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- The caller supplies the unavailable runtime interface represented by this throwing proxy.
const unavailableRuntime = <T>(message: string): T =>
  new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error(message);
      },
    },
  ) as T;

// Organization internals are reachable from the organization's own workspaces only.
const ownerOrgScope = (execution: BackofficeExecutionContext): { orgId: string } | null => {
  const organization = backofficeWorkspaceOrganization(execution.scope);
  return organization ? { orgId: organization.orgId } : null;
};

const selectedOrgScope = (
  execution: BackofficeExecutionContext,
): Extract<BackofficeExecutionContext["scope"], { kind: "org" }> | null =>
  execution.scope.kind === "org" ? execution.scope : null;

/**
 * Retained output reveals what its run could read, so a reader needs at least the run's authority:
 * the same principal, a delegation chain the run's chain extends (each delegate only narrows), and a
 * scope ceiling that contains the run's. Grants changed since the run are not re-checked.
 */
function coversCodemodeRun(reader: BackofficeExecutionContext, run: CodemodeRunContext): boolean {
  const readerPrincipal = reader.actors.principal;
  const runPrincipal = run.actors.principal;
  const samePrincipal =
    readerPrincipal === null || runPrincipal === null
      ? readerPrincipal === runPrincipal
      : automationEntityRefsEqual(readerPrincipal, runPrincipal);
  const readerDelegation = reader.actors.delegation;
  const runDelegation = run.actors.delegation;
  const delegationPrefix =
    readerDelegation.length <= runDelegation.length &&
    readerDelegation.every((actor, index) =>
      automationEntityRefsEqual(actor, runDelegation[index]),
    );
  const readerCeiling = backofficeExecutionScopeRestriction(reader);
  const ceilingCovers =
    readerCeiling === null ||
    (run.scopeRestriction !== null && backofficeScopeContains(readerCeiling, run.scopeRestriction));
  return samePrincipal && delegationPrefix && ceilingCovers;
}

function createCodemodeRunHistory(
  reader: BackofficeExecutionContext,
  codemode: () => CodemodeCommands,
): JavaScriptRunHistory {
  function summarizeRun(run: CodemodeRun) {
    return {
      runId: run.id,
      activation:
        run.activationKind === "workflow"
          ? { kind: "workflow" as const, workflowInstanceId: run.workflowInstanceId }
          : { kind: run.activationKind },
      origin: run.origin,
      startedAt: run.createdAt,
    };
  }
  return {
    async listRuns(input) {
      const page = await codemode().listRuns(
        input.cursor === undefined
          ? { page: "first", pageSize: input.limit ?? 20 }
          : { page: "next", cursor: input.cursor },
      );
      return {
        runs: page.runs
          .filter((run) => coversCodemodeRun(reader, run))
          .map((run) => ({ ...summarizeRun(run), status: run.status })),
        nextCursor: page.hasNextPage ? page.cursor : null,
      };
    },
    async getRun({ runId }) {
      const run = await codemode().getRun(runId);
      if (!run) {
        throw new Error(
          `CODEMODE_RUN_NOT_FOUND: ${runId} does not exist in this scope or expired after 7 days.`,
        );
      }
      if (!coversCodemodeRun(reader, run)) {
        throw new Error(
          `CODEMODE_RUN_FORBIDDEN: ${runId} ran with authority this caller does not hold.`,
        );
      }
      const detail = {
        ...summarizeRun(run),
        toolCalls: run.toolCalls,
        toolCallsTruncated: run.toolCallsTruncated,
      };
      if (run.status === "running") {
        return { ...detail, status: "running" };
      }
      return run.status === "failed"
        ? { ...detail, status: "failed", logs: run.logs, error: run.error.message }
        : { ...detail, status: run.status, logs: run.logs };
    },
  };
}

function userPrincipalId(execution: BackofficeExecutionContext): string | null {
  const principal = execution.actors.principal;
  return principal?.scope === "internal" && principal.type === "user" ? principal.id : null;
}

const unavailableObject = <T>(resolve: () => T): T | null => {
  try {
    return resolve();
  } catch (error) {
    if (isBackofficeUnavailableError(error)) {
      return null;
    }
    throw error;
  }
};

export const createRouteBackedRuntimeContext = ({
  runtime,
  kernel,
  execution,
  emitter,
  emittedEventActors,
  emittedEventSource,
  pi,
  workflowSourceReader,
}: RouteBackedRuntimeContextOptions): InteractiveRuntimeToolContext => {
  const org = ownerOrgScope(execution);
  const selectedOrg = selectedOrgScope(execution);
  // Installations are managed where they belong: in their organization or personal scope.
  const installationOwner =
    execution.scope.kind === "org" || execution.scope.kind === "user" ? execution.scope : null;
  const userId = userPrincipalId(execution);
  const stateBackend =
    execution.scope.kind === "system" || runtime.config.bindings.upload
      ? createRuntimeStateBackend({ runtime, kernel, execution })
      : undefined;
  const javaScriptStateBackend =
    stateBackend ??
    createBackofficeSystemStateBackend({
      staticFileCollection: createBackofficeStaticFileCollection(),
      systemFileCollection: createStaticFileCollection({}),
    });
  const automationsObject = kernel.scoped(
    "AUTOMATIONS",
    execution.scope,
    runtime.objects.automations,
  );
  const codemodeExecutor = runtime.codemodeExecutor;
  // Resolved per use: a local runtime instantiates an object as soon as its handle is created.
  const codemodeObject = () =>
    kernel.scoped("CODEMODE", execution.scope, runtime.objects.codemode).commands;
  const codemodeRunner = () => codemodeRunnerFor(codemodeObject(), execution);

  const formsObjects = runtime.objects.forms;
  const uploadObject = () => kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload);

  return {
    execution,
    backofficeKernel: kernel,
    stateBackend,
    fileLinks:
      runtime.config.bindings.upload && isBackofficeRoutableScope(execution.scope)
        ? {
            runtime: createFileLinkRuntime({
              uploadObject: () => uploadObject().http,
              scope: execution.scope,
              origins:
                runtime.config.docsPublicBaseUrl && runtime.config.sandboxBackofficeBaseUrl
                  ? {
                      public: runtime.config.docsPublicBaseUrl,
                      sandbox: runtime.config.sandboxBackofficeBaseUrl,
                    }
                  : null,
            }),
          }
        : null,
    account:
      runtime.config.bindings.auth && userId
        ? {
            runtime: createAccountRuntime({ objects: runtime.objects, userId }),
          }
        : null,
    org:
      runtime.config.bindings.auth && userId && selectedOrg
        ? {
            runtime: createOrganizationRuntime({
              objects: runtime.objects,
              organizationId: selectedOrg.orgId,
              userId,
              publicBaseUrl: runtime.config.docsPublicBaseUrl ?? null,
            }),
          }
        : null,
    admin:
      runtime.config.bindings.auth && execution.scope.kind === "system"
        ? {
            runtime: createAdminRuntime({
              auth: runtime.objects.auth.singleton().commands,
              apps: unavailableObject(() => runtime.objects.apps.singleton())?.commands ?? null,
              otp: runtime.config.bindings.otp ? runtime.objects.otp.singleton().commands : null,
              resend: runtime.config.bindings.resend
                ? runtime.objects.resend.singleton().commands
                : null,
              automationsForOrg: (organizationId) =>
                runtime.objects.automations.forOrg(organizationId).commands,
              publicBaseUrl: runtime.config.docsPublicBaseUrl ?? null,
            }),
          }
        : null,
    apps:
      runtime.config.bindings.auth && installationOwner
        ? (() => {
            const apps = unavailableObject(() => runtime.objects.apps.singleton());
            const installations = unavailableObject(() =>
              kernel.scoped(
                "APP_INSTALLATIONS",
                installationOwner,
                runtime.objects.appInstallations,
              ),
            );
            return installations
              ? {
                  runtime: createAppsRuntime({
                    apps: apps?.commands ?? null,
                    installations: installations.commands,
                  }),
                }
              : null;
          })()
        : null,
    createBackofficeScopedContext: (scope) => {
      kernel.assertScopedContextAccess(execution, scope);
      return createRouteBackedRuntimeContext({
        runtime,
        kernel,
        execution: {
          ...execution,
          scope,
        },
        emitter,
        emittedEventActors,
        emittedEventSource,
        pi,
        workflowSourceReader: backofficeContextScopesEqual(execution.scope, scope)
          ? workflowSourceReader
          : undefined,
      });
    },
    backoffice: isBackofficeRoutableScope(execution.scope)
      ? {
          runtime: createBackofficeCapabilitiesRuntime({
            objects: runtime.objects,
            config: runtime.config,
            scope: execution.scope,
          }),
        }
      : null,
    eventCatalog: isBackofficeRoutableScope(execution.scope)
      ? { runtime: createEventCatalogRuntime({ objects: runtime.objects, kernel, execution }) }
      : null,
    automation: null,
    marketplace: runtime.config.bindings.marketplace
      ? {
          runtime: createMarketplaceRuntime({
            objects: runtime.objects,
            execution,
            kernel,
            publication:
              stateBackend &&
              runtime.config.bindings.upload &&
              runtime.config.bindings.automations &&
              runtime.config.bindings.auth
                ? { state: stateBackend }
                : null,
          }),
        }
      : null,
    packages:
      runtime.config.bindings.upload &&
      runtime.config.bindings.automations &&
      runtime.config.bindings.marketplace &&
      isBackofficeRoutableScope(execution.scope)
        ? {
            runtime: createPackagesRuntime({
              objects: runtime.objects,
              kernel,
              execution,
              preferredOrganizationId:
                ("userAuthority" in execution ? execution.userAuthority?.organizationId : null) ??
                null,
            }),
          }
        : null,
    cloudflare: runtime.config.bindings.cloudflare
      ? (() => {
          const object = unavailableObject(() => runtime.objects.cloudflare.singleton());
          return object ? { runtime: createCloudflareRuntime({ http: object.http }) } : null;
        })()
      : null,
    web: runtime.config.bindings.cloudflare
      ? (() => {
          const object = unavailableObject(() => runtime.objects.cloudflare.singleton());
          return object ? { runtime: createWebRuntime({ object: object.http }) } : null;
        })()
      : null,
    // Building a page runs codemode, and the build loads this module, so it is imported per use.
    artifacts: codemodeExecutor
      ? {
          runtime: {
            loadPage: async (sourcePath) => {
              const { loadPage } = await import("@/artifacts/pages/build.server");
              return await loadPage({ runtime, kernel, execution, sourcePath });
            },
          },
        }
      : null,
    models: {
      runtime: {
        classify: async (request) =>
          await kernel
            .scoped("PI_MANAGER", execution.scope, runtime.objects.piManager)
            .commands.classify({ request }),
        generateImage: async (request) =>
          await kernel
            .scoped("PI_MANAGER", execution.scope, runtime.objects.piManager)
            .commands.generateImage({ request }),
      },
    },
    event: {
      runtime: createEventRuntime({
        objects: runtime.objects,
        emitter,
        kernel,
        execution,
        emittedEventActors,
        emittedEventSource,
      }),
    },
    automations: {
      runtime: {
        ...createRouteBackedAutomationStoreRuntime({ object: automationsObject, execution }),
        ...createRouteBackedAutomationRouterRuntime({ object: automationsObject, execution }),
      },
    },
    // Never escalate a project-scoped run to its owner's scope to create a sibling.
    projects:
      runtime.config.bindings.automations &&
      userId &&
      (execution.scope.kind === "org" || execution.scope.kind === "user")
        ? { runtime: createProjectsRuntime({ object: automationsObject, execution, userId }) }
        : null,
    identity: {
      runtime: createRouteBackedAutomationIdentityRuntime({ object: automationsObject, execution }),
    },
    workflow: {
      runtime: createRouteBackedAutomationWorkflowRuntime({
        object: automationsObject,
        execution,
        prepareSavedWorkflowInstance: async ({ path, instanceId, payload }) => {
          const sourceReader =
            workflowSourceReader ??
            (({ path: sourcePath }) =>
              readBackofficeAutomationSource({
                objects: runtime.objects,
                config: runtime.config,
                execution,
                kernel,
                path: sourcePath,
              }));
          const program = await readSavedWorkflowProgram({
            path: resolveAutomationScriptPath(path),
            readFile: async (modulePath) => await sourceReader({ execution, path: modulePath }),
          });
          const prepared = prepareCodemodeWorkflowInstance({ program, instanceId });
          return createCodemodeWorkflowInstanceInput({
            prepared,
            trigger: { type: "manual", payload: payload ?? {} },
            execution,
            replyTo: null,
          });
        },
      }),
    },
    durableHooks: org
      ? {
          runtime: createRouteBackedDurableHooksRuntime({
            objects: runtime.objects,
            config: runtime.config,
            orgId: org.orgId,
          }),
        }
      : null,
    forms:
      execution.scope.kind === "system" && formsObjects
        ? (() => {
            const object = unavailableObject(() => formsObjects.singleton());
            return object
              ? {
                  runtime: createFormsRuntime(
                    authorizedBackofficeObjectHttp(object.http, execution),
                  ),
                }
              : null;
          })()
        : null,
    internal: org
      ? {
          runtime: createInternalRuntime({
            objects: runtime.objects,
            scope: { kind: "org", orgId: org.orgId },
          }),
        }
      : null,
    otp: {
      runtime: selectedOrg
        ? {
            createClaim: async (input) => {
              const resolvedScope = {
                kind: "org" as const,
                organization: await resolveRuntimeOrganization(runtime, selectedOrg.orgId),
              };
              return await createOtpRuntime({
                object: kernel.scoped("OTP", execution.scope, runtime.objects.otp).commands,
                config: runtime.config,
                scope: resolvedScope,
                kernel,
                execution,
              }).createClaim(input);
            },
          }
        : createUnavailableOtpRuntime(unavailableMessage("OTP", execution)),
    },
    pi: (typeof pi === "function" ? pi(execution) : pi) ?? {
      runtime: createPiManagerRuntime({
        runtime,
        kernel,
        execution,
      }),
    },
    integrations: {
      runtime: createIntegrationsRuntime({ runtime, kernel, execution, nowEpochMs: Date.now }),
    },
    reson8: runtime.reson8
      ? {
          runtime: createReson8Runtime({
            reson8: runtime.reson8,
            scope: execution.scope,
            billing: usageBillingForScope(runtime, execution.scope),
            nowEpochMs: Date.now,
          }),
        }
      : null,
    sandbox:
      runtime.config.bindings.sandbox && runtime.config.bindings.automations
        ? {
            runtime: isBackofficeObjectAvailableInContext("SANDBOX_MANAGER", execution.scope)
              ? createSandboxRuntime({
                  lifecycle: kernel.scoped(
                    "SANDBOX_MANAGER",
                    execution.scope,
                    runtime.objects.sandboxManager,
                  ).commands,
                })
              : unavailableRuntime(unavailableMessage("SANDBOX", execution)),
          }
        : null,
    javascript:
      runtime.workerTypeChecker || codemodeExecutor
        ? {
            runtime: {
              ...createJavaScriptRuntime({
                getStateBackend: async () => javaScriptStateBackend,
                typeCheckFiles: runtime.workerTypeChecker,
                executeModule: codemodeExecutor
                  ? async (program, toolContext) => {
                      const { runBackofficeJavaScriptModule } =
                        await import("@/fragno/codemode/javascript-module-execute");
                      return await runBackofficeJavaScriptModule({
                        program,
                        codemode: codemodeRunner(),
                        families: runtimeToolFamilies,
                        toolContext,
                      });
                    }
                  : null,
              }),
              // Without an executor there are no runs to read.
              runHistory: codemodeExecutor
                ? createCodemodeRunHistory(execution, codemodeObject)
                : null,
              buildFile:
                codemodeExecutor && execution.scope.kind !== "system"
                  ? async (input) => {
                      try {
                        return await buildJavaScriptModuleFile({
                          path: input.path,
                          out: input.out,
                          state: javaScriptStateBackend,
                          codemode: codemodeRunner(),
                        });
                      } catch (error) {
                        return {
                          status: "rejected",
                          path: input.path,
                          outputPath: input.out,
                          error: error instanceof Error ? error.message : String(error),
                        };
                      }
                    }
                  : null,
            },
          }
        : null,
  };
};

export const createCodemodeRouteBackedRuntimeContext = (
  options: RouteBackedRuntimeContextOptions,
): InteractiveRuntimeToolContext & { stateBackend: BackofficeStateBackend } => {
  const context = createRouteBackedRuntimeContext(options);
  if (!context.stateBackend) {
    throw new Error("Codemode requires Upload-backed state routes.");
  }
  return { ...context, stateBackend: context.stateBackend };
};
