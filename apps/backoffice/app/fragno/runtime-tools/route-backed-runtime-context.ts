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
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import {
  readAutomationScript,
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
import type { CodemodeRunContext } from "@/fragno/codemode/codemode-fragment";
import { codemodeRunnerFor } from "@/fragno/codemode/codemode-object-execute";
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import { readSavedModuleImports } from "@/fragno/codemode/saved-module-imports";
import {
  createBackofficeSystemStateBackend,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
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
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createFormsRuntime } from "@/fragno/runtime-tools/families/forms-runtime";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { createJavaScriptRuntime } from "@/fragno/runtime-tools/families/javascript-runtime";
import { createMarketplaceRuntime } from "@/fragno/runtime-tools/families/marketplace-runtime";
import { createOrganizationRuntime } from "@/fragno/runtime-tools/families/organization-runtime";
import {
  createOtpRuntime,
  createUnavailableOtpRuntime,
} from "@/fragno/runtime-tools/families/otp-runtime";
import { createPackagesRuntime } from "@/fragno/runtime-tools/families/packages-runtime";
import { createSandboxRouteRuntime } from "@/fragno/runtime-tools/families/sandbox-route-runtime";
import {
  createUploadRuntime,
  createUploadStorageRuntime,
} from "@/fragno/runtime-tools/families/upload-runtime";
import { createWebRuntime } from "@/fragno/runtime-tools/families/web-runtime";

import type { InteractiveRuntimeToolContext } from "./bash-host";
import { buildJavaScriptModuleFile } from "./families/javascript-build";
import { resolveRuntimeOrganization } from "./runtime-public-scope";
import { runtimeToolFamilies } from "./tool-families";

export type RouteBackedRuntimeContextOptions = {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  billingOrganizationId: string | null;
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
  billingOrganizationId,
  emittedEventActors,
  emittedEventSource,
  pi,
  workflowSourceReader,
}: RouteBackedRuntimeContextOptions): InteractiveRuntimeToolContext => {
  const org = ownerOrgScope(execution);
  const selectedOrg = selectedOrgScope(execution);
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
  const codemodeEnv = runtime.codemodeEnv;
  const canCompileJavaScript =
    codemodeEnv !== null &&
    ("remoteExecutor" in codemodeEnv ||
      Boolean(codemodeEnv.CODEMODE_COMPILER || codemodeEnv.compileWorker));
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
              publicBaseUrl: runtime.config.docsPublicBaseUrl ?? null,
            }),
          }
        : null,
    apps:
      runtime.config.bindings.auth && selectedOrg
        ? (() => {
            const apps = unavailableObject(() => runtime.objects.apps.singleton());
            const installations = unavailableObject(() =>
              kernel.scoped("APP_INSTALLATIONS", selectedOrg, runtime.objects.appInstallations),
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
        billingOrganizationId,
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
                billingOrganizationId,
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
    event: {
      runtime: createEventRuntime({
        objects: runtime.objects,
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
          const script = await readAutomationScript(sourceReader, {
            execution,
            scriptPath: path,
          });
          if (!script.absolutePath.endsWith(".workflow.js")) {
            throw new Error(
              `Saved workflow path '${script.absolutePath}' must end with '.workflow.js'.`,
            );
          }
          const { modules } = await readSavedModuleImports({
            readFile: async (modulePath) => await sourceReader({ execution, path: modulePath }),
            program: { kind: "inline", code: script.body },
          });
          const prepared = prepareCodemodeWorkflowInstance({
            code: script.body,
            modules,
            filename: script.absolutePath,
            instanceId,
          });
          return createCodemodeWorkflowInstanceInput({
            prepared,
            trigger: { type: "manual", payload: payload ?? {} },
            execution,
            billingOrganizationId,
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
        defaultBillingOrganizationId: billingOrganizationId,
      }),
    },
    integrations: {
      runtime: createIntegrationsRuntime({ runtime, kernel, execution, nowEpochMs: Date.now }),
    },
    sandbox:
      runtime.config.bindings.sandbox && runtime.config.bindings.automations
        ? {
            runtime: selectedOrg
              ? createSandboxRouteRuntime({
                  objects: runtime.objects,
                  orgId: selectedOrg.orgId,
                })
              : unavailableRuntime(unavailableMessage("SANDBOX", execution)),
          }
        : null,
    javascript:
      runtime.workerTypeChecker || codemodeEnv
        ? {
            runtime: {
              ...createJavaScriptRuntime({
                getStateBackend: async () => javaScriptStateBackend,
                typeCheckFiles: runtime.workerTypeChecker,
                executeModule: codemodeEnv
                  ? async (program, toolContext) => {
                      if (program.kind === "source" && !canCompileJavaScript) {
                        throw new Error(
                          "JavaScript source execution requires a compiler; run a built JSON module artifact instead.",
                        );
                      }
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
              readRunLogs: codemodeEnv
                ? async ({ runId }) => {
                    const run = await codemodeObject().getRun(runId);
                    if (!run) {
                      throw new Error(
                        `CODEMODE_RUN_NOT_FOUND: ${runId} does not exist in this scope or expired after 7 days.`,
                      );
                    }
                    if (!coversCodemodeRun(execution, run)) {
                      throw new Error(
                        `CODEMODE_RUN_FORBIDDEN: ${runId} ran with authority this caller does not hold.`,
                      );
                    }
                    if (run.status === "running") {
                      return { runId, status: "running" };
                    }
                    return run.status === "completed"
                      ? { runId, status: "completed", logs: run.logs }
                      : { runId, status: "failed", logs: run.logs, error: run.error.message };
                  }
                : null,
              buildFile:
                canCompileJavaScript && codemodeEnv && execution.scope.kind !== "system"
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
                          artifactPath: input.out,
                          error: error instanceof Error ? error.message : String(error),
                        };
                      }
                    }
                  : null,
            },
          }
        : null,
    upload:
      runtime.config.bindings.upload && isBackofficeRoutableScope(execution.scope)
        ? {
            runtime: {
              ...createUploadRuntime(uploadObject().http),
              ...createUploadStorageRuntime(uploadObject().commands, execution.scope),
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
