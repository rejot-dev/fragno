import { authorizedBackofficeObjectHttp } from "@/backoffice-runtime/authorized-object-http";
import {
  backofficeContextScopesEqual,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { isBackofficeUnavailableError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import { isBackofficeObjectAvailableInContext } from "@/backoffice-runtime/object-registry";
import {
  backofficeRouteScopeFromResolvedScope,
  resolveBackofficeRuntimeScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createStaticFileCollection } from "@/file-collection/create-static-file-collection";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import type { AutomationActors } from "@/fragno/automation/actors";
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
import { createRuntimeStateBackend } from "@/fragno/codemode/runtime-state-backend";
import {
  createBackofficeSystemStateBackend,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { createCodemodeStaticArtifactsResolver } from "@/fragno/codemode/static-codemode-artifacts";
import {
  createPiManagerRuntime,
  type PiManagerRuntime,
} from "@/fragno/pi-manager/pi-manager-runtime";
import { createAccountRuntime } from "@/fragno/runtime-tools/families/account-runtime";
import { createAdminRuntime } from "@/fragno/runtime-tools/families/admin-runtime";
import { createApiRuntime } from "@/fragno/runtime-tools/families/api-runtime";
import { createAppsRuntime } from "@/fragno/runtime-tools/families/apps-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createCloudflareRuntime } from "@/fragno/runtime-tools/families/cloudflare-runtime";
import { createEventCatalogRuntime } from "@/fragno/runtime-tools/families/event-catalog";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createFormsRuntime } from "@/fragno/runtime-tools/families/forms-runtime";
import { createGitHubRuntime } from "@/fragno/runtime-tools/families/github-runtime";
import { createIntegrationsRuntime } from "@/fragno/runtime-tools/families/integrations/integrations-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { createJavaScriptRuntime } from "@/fragno/runtime-tools/families/javascript-runtime";
import { createMarketplaceRuntime } from "@/fragno/runtime-tools/families/marketplace-runtime";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import { createOrganizationRuntime } from "@/fragno/runtime-tools/families/organization-runtime";
import {
  createOtpRuntime,
  createUnavailableOtpRuntime,
} from "@/fragno/runtime-tools/families/otp-runtime";
import { createPackagesRuntime } from "@/fragno/runtime-tools/families/packages-runtime";
import { createProjectConnectorRuntime } from "@/fragno/runtime-tools/families/project-connector-runtime";
import {
  createResendRouteRuntime,
  createUnavailableResendRuntime,
} from "@/fragno/runtime-tools/families/resend-runtime";
import { createSandboxRouteRuntime } from "@/fragno/runtime-tools/families/sandbox-route-runtime";
import {
  createTelegramRuntime,
  createUnavailableTelegramRuntime,
} from "@/fragno/runtime-tools/families/telegram-runtime";
import { createUploadRuntime } from "@/fragno/runtime-tools/families/upload-runtime";
import { createWebRuntime } from "@/fragno/runtime-tools/families/web-runtime";
import {
  apiPublicAddress,
  mcpPublicAddress,
  projectConnectorPublicAddress,
} from "@/fragno/scoped-public-fragment-routes";

import type { InteractiveRuntimeToolContext } from "./bash-host";
import { buildJavaScriptModuleFile } from "./families/javascript-build";
import { getRuntimeToolNamespacesByCapability, runtimeToolFamilies } from "./tool-families";

export type RouteBackedRuntimeContextOptions = {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  billingOrganizationId: string | null;
  emittedEventActors?: AutomationActors;
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

const ownerOrgScope = (execution: BackofficeExecutionContext): { orgId: string } | null =>
  execution.scope.kind === "org" || execution.scope.kind === "project"
    ? { orgId: execution.scope.orgId }
    : null;

const selectedOrgScope = (
  execution: BackofficeExecutionContext,
): Extract<BackofficeExecutionContext["scope"], { kind: "org" }> | null =>
  execution.scope.kind === "org" ? execution.scope : null;

function userPrincipalId(execution: BackofficeExecutionContext): string | null {
  const principal = execution.actors.principal;
  return principal?.scope === "internal" && principal.type === "user" ? principal.id : null;
}

function createExecutionStaticFileCollection({
  runtime,
  execution,
}: Pick<RouteBackedRuntimeContextOptions, "runtime" | "execution">) {
  return createBackofficeStaticFileCollection(
    createCodemodeStaticArtifactsResolver({
      objects: runtime.objects,
      config: runtime.config,
      execution,
    }),
  );
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

async function resolveRuntimeOrganization(
  runtime: BackofficeRuntimeServices,
  organizationId: string,
) {
  const organization = (await runtime.objects.auth.singleton().commands.getAllOrganizations()).find(
    ({ id }) => id === organizationId,
  );
  if (!organization) {
    throw new Error(`Organization '${organizationId}' could not be found.`);
  }
  return { id: organization.id, slug: organization.slug };
}

export const createRouteBackedRuntimeContext = ({
  runtime,
  kernel,
  execution,
  billingOrganizationId,
  emittedEventActors,
  pi,
  workflowSourceReader,
}: RouteBackedRuntimeContextOptions): InteractiveRuntimeToolContext => {
  const org = ownerOrgScope(execution);
  const selectedOrg = selectedOrgScope(execution);
  const userId = userPrincipalId(execution);
  const internalScope =
    execution.scope.kind === "system"
      ? execution.scope
      : org
        ? { kind: "org" as const, orgId: org.orgId }
        : null;
  const stateBackend =
    execution.scope.kind === "system" || runtime.config.bindings.upload
      ? createRuntimeStateBackend({ runtime, kernel, execution })
      : undefined;
  const javaScriptStateBackend =
    stateBackend ??
    createBackofficeSystemStateBackend({
      staticFileCollection: createExecutionStaticFileCollection({ runtime, execution }),
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

  const formsObjects = runtime.objects.forms;

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
            runtimeToolNamespacesByCapability: getRuntimeToolNamespacesByCapability(),
          }),
        }
      : null,
    eventCatalog: isBackofficeRoutableScope(execution.scope)
      ? { runtime: createEventCatalogRuntime({ objects: runtime.objects, scope: execution.scope }) }
      : null,
    automation: null,
    marketplace: runtime.config.bindings.marketplace
      ? {
          runtime: createMarketplaceRuntime(
            runtime.objects.marketplace.singleton().commands,
            stateBackend &&
              runtime.config.bindings.upload &&
              runtime.config.bindings.automations &&
              runtime.config.bindings.auth
              ? {
                  state: stateBackend,
                  execution,
                  kernel,
                }
              : null,
          ),
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
          const prepared = prepareCodemodeWorkflowInstance({
            code: script.body,
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
    github:
      runtime.config.bindings.github && org
        ? {
            runtime: createGitHubRuntime(
              authorizedBackofficeObjectHttp(
                runtime.objects.github.forOrg(org.orgId).http,
                execution,
              ),
            ),
          }
        : null,
    internal: internalScope
      ? {
          runtime: createInternalRuntime({
            objects: runtime.objects,
            scope: internalScope,
          }),
        }
      : null,
    api: runtime.config.bindings.api
      ? (() => {
          const object = isBackofficeObjectAvailableInContext("API", execution.scope)
            ? kernel.scoped("API", execution.scope, runtime.objects.api)
            : null;
          return object
            ? {
                runtime: createApiRuntime(
                  authorizedBackofficeObjectHttp(object.http, execution),
                  async () => {
                    const resolvedScope = await resolveBackofficeRuntimeScope(
                      execution.scope,
                      (organizationId) => resolveRuntimeOrganization(runtime, organizationId),
                    );
                    if (resolvedScope.kind === "system") {
                      throw new Error("API public routes require a routable scope.");
                    }
                    return apiPublicAddress(
                      runtime.config.docsPublicBaseUrl,
                      backofficeRouteScopeSinglePathSegment(
                        backofficeRouteScopeFromResolvedScope(resolvedScope),
                      ),
                    );
                  },
                ),
              }
            : null;
        })()
      : null,
    mcp: runtime.config.bindings.mcp
      ? (() => {
          const object = isBackofficeObjectAvailableInContext("MCP", execution.scope)
            ? kernel.scoped("MCP", execution.scope, runtime.objects.mcp)
            : null;
          return object
            ? {
                runtime: createMcpRuntime(
                  authorizedBackofficeObjectHttp(object.http, execution),
                  async () => {
                    const resolvedScope = await resolveBackofficeRuntimeScope(
                      execution.scope,
                      (organizationId) => resolveRuntimeOrganization(runtime, organizationId),
                    );
                    if (resolvedScope.kind === "system") {
                      throw new Error("MCP public routes require a routable scope.");
                    }
                    return mcpPublicAddress(
                      runtime.config.docsPublicBaseUrl,
                      backofficeRouteScopeSinglePathSegment(
                        backofficeRouteScopeFromResolvedScope(resolvedScope),
                      ),
                    );
                  },
                ),
              }
            : null;
        })()
      : null,
    projectConnector: runtime.config.bindings.projectConnector
      ? (() => {
          const object = isBackofficeObjectAvailableInContext("PROJECT_CONNECTOR", execution.scope)
            ? kernel.scoped("PROJECT_CONNECTOR", execution.scope, runtime.objects.projectConnector)
            : null;
          return object
            ? {
                runtime: createProjectConnectorRuntime(
                  authorizedBackofficeObjectHttp(object.http, execution),
                  async () => {
                    const resolvedScope = await resolveBackofficeRuntimeScope(
                      execution.scope,
                      (organizationId) => resolveRuntimeOrganization(runtime, organizationId),
                    );
                    if (resolvedScope.kind === "system") {
                      throw new Error("Connector public routes require a routable scope.");
                    }
                    return projectConnectorPublicAddress(
                      runtime.config.docsPublicBaseUrl,
                      backofficeRouteScopeSinglePathSegment(
                        backofficeRouteScopeFromResolvedScope(resolvedScope),
                      ),
                    );
                  },
                ),
              }
            : null;
        })()
      : null,
    otp: {
      runtime: selectedOrg
        ? {
            createClaim: async (input) => {
              const resolvedScope = await resolveBackofficeRuntimeScope(
                selectedOrg,
                (organizationId) => resolveRuntimeOrganization(runtime, organizationId),
              );
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
    resend: {
      runtime:
        selectedOrg && runtime.config.bindings.resend
          ? createResendRouteRuntime({
              object: authorizedBackofficeObjectHttp(
                kernel.scoped("RESEND", execution.scope, runtime.objects.resend).http,
                execution,
              ),
            })
          : createUnavailableResendRuntime(unavailableMessage("RESEND", execution)),
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
                        return {
                          result: undefined,
                          error:
                            "JavaScript source execution requires a compiler; run a built JSON module artifact instead.",
                          logs: [],
                          toolCalls: [],
                        };
                      }
                      const { runBackofficeJavaScriptModule } =
                        await import("@/fragno/codemode/javascript-module-execute");
                      return await runBackofficeJavaScriptModule({
                        program,
                        env: codemodeEnv,
                        families: runtimeToolFamilies,
                        toolContext,
                      });
                    }
                  : null,
              }),
              buildFile:
                canCompileJavaScript && codemodeEnv && execution.scope.kind !== "system"
                  ? async (input) => {
                      try {
                        const output = await buildJavaScriptModuleFile({
                          path: input.path,
                          out: input.out,
                          state: javaScriptStateBackend,
                          env: codemodeEnv,
                        });
                        return { status: "success", ...output };
                      } catch (error) {
                        return {
                          status: "error",
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
            runtime: createUploadRuntime(
              kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload).http,
            ),
          }
        : null,
    telegram:
      execution.scope.kind === "org" && runtime.config.bindings.telegram
        ? {
            runtime: createTelegramRuntime({
              object: kernel.scoped("TELEGRAM", execution.scope, runtime.objects.telegram),
              execution,
              kernel,
            }),
          }
        : {
            runtime: createUnavailableTelegramRuntime(
              `TELEGRAM is not available in ${execution.scope.kind} context.`,
            ),
          },
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
