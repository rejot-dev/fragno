import {
  backofficeContextScopesEqual,
  type BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import { BackofficeUnavailableError, type BackofficeKernel } from "@/backoffice-runtime/kernel";
import {
  backofficeRouteScopeFromResolvedScope,
  resolveBackofficeRuntimeScope,
} from "@/backoffice-runtime/resolved-scope";
import { backofficeRouteScopeSinglePathSegment } from "@/backoffice-runtime/route-scope";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { isBackofficeRoutableScope } from "@/backoffice-runtime/scope-codec";
import { createBackofficeFileSystem, type IFileSystem } from "@/files";
import { createBackofficeStaticFileCollection } from "@/files/content/static";
import type { AutomationActors } from "@/fragno/automation/actors";
import { createRouteBackedAutomationStoreRuntime } from "@/fragno/automation/bindings-route-runtime";
import { readAutomationWorkspaceScript } from "@/fragno/automation/catalog";
import { createRouteBackedDurableHooksRuntime } from "@/fragno/automation/durable-hooks-route-runtime";
import {
  createCodemodeWorkflowInstanceInput,
  prepareCodemodeWorkflowInstance,
} from "@/fragno/automation/engine/codemode-invocation";
import { createRouteBackedAutomationIdentityRuntime } from "@/fragno/automation/external-identities-route-runtime";
import { createRouteBackedAutomationRouterRuntime } from "@/fragno/automation/routing-route-runtime";
import { createRouteBackedAutomationWorkflowRuntime } from "@/fragno/automation/workflow-route-runtime";
import {
  createBackofficeStateBackend,
  type BackofficeStateBackend,
} from "@/fragno/codemode/state-backend";
import { createCodemodeStaticArtifactsResolver } from "@/fragno/codemode/static-codemode-artifacts";
import { createAdminRuntime } from "@/fragno/runtime-tools/families/admin-runtime";
import { createApiRuntime } from "@/fragno/runtime-tools/families/api-runtime";
import { createBackofficeCapabilitiesRuntime } from "@/fragno/runtime-tools/families/backoffice-capabilities";
import { createCloudflareRuntime } from "@/fragno/runtime-tools/families/cloudflare-runtime";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import { createInternalRuntime } from "@/fragno/runtime-tools/families/internal";
import { createMcpRuntime } from "@/fragno/runtime-tools/families/mcp-runtime";
import {
  createOtpRuntime,
  createUnavailableOtpRuntime,
} from "@/fragno/runtime-tools/families/otp-runtime";
import { createPiRouteRuntime, type PiRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import {
  createResendRouteRuntime,
  createUnavailableResendRuntime,
} from "@/fragno/runtime-tools/families/resend-runtime";
import {
  createReson8RouteRuntime,
  createUnavailableReson8Runtime,
} from "@/fragno/runtime-tools/families/reson8-runtime";
import { createSandboxRouteRuntime } from "@/fragno/runtime-tools/families/sandbox-route-runtime";
import {
  createTelegramRuntime,
  createUnavailableTelegramRuntime,
} from "@/fragno/runtime-tools/families/telegram-runtime";
import { createUploadRuntime } from "@/fragno/runtime-tools/families/upload-runtime";
import { createWebRuntime } from "@/fragno/runtime-tools/families/web-runtime";
import { apiPublicAddress, mcpPublicAddress } from "@/fragno/scoped-public-fragment-routes";

import type { InteractiveRuntimeToolContext } from "./bash-host";
import { getRuntimeToolNamespacesByCapability, runtimeToolFamilies } from "./tool-families";

export type RouteBackedRuntimeContextOptions = {
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
  emittedEventActors?: AutomationActors;
  pi?: { runtime: PiRuntime } | null;
  workflowSourceFileSystem?: IFileSystem;
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

const createExecutionStateBackend = ({
  runtime,
  kernel,
  execution,
}: Pick<RouteBackedRuntimeContextOptions, "runtime" | "kernel" | "execution">):
  | BackofficeStateBackend
  | undefined => {
  if (!runtime.config.bindings.upload || !isBackofficeRoutableScope(execution.scope)) {
    return undefined;
  }

  return createBackofficeStateBackend({
    uploadObject: kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload),
    staticFileCollection: createBackofficeStaticFileCollection(
      createCodemodeStaticArtifactsResolver({
        objects: runtime.objects,
        config: runtime.config,
        execution,
      }),
    ),
  });
};

async function resolveRuntimeOrganization(
  runtime: BackofficeRuntimeServices,
  organizationId: string,
) {
  const organization = (await runtime.objects.auth.singleton().getAllOrganizations()).find(
    ({ id }) => id === organizationId,
  );
  if (!organization) {
    throw new Error(`Organization '${organizationId}' could not be found.`);
  }
  return { id: organization.id, slug: organization.slug };
}

const unavailableObject = <T>(resolve: () => T): T | null => {
  try {
    return resolve();
  } catch (error) {
    if (error instanceof BackofficeUnavailableError) {
      return null;
    }
    throw error;
  }
};

export const createRouteBackedRuntimeContext = ({
  runtime,
  kernel,
  execution,
  emittedEventActors,
  pi,
  workflowSourceFileSystem,
}: RouteBackedRuntimeContextOptions): InteractiveRuntimeToolContext => {
  const org = ownerOrgScope(execution);
  const selectedOrg = selectedOrgScope(execution);
  const automationsObject = kernel.scoped(
    "AUTOMATIONS",
    execution.scope,
    runtime.objects.automations,
  );

  return {
    execution,
    backofficeKernel: kernel,
    stateBackend: createExecutionStateBackend({ runtime, kernel, execution }),
    admin:
      runtime.config.bindings.auth && execution.scope.kind === "system"
        ? { runtime: createAdminRuntime(runtime.objects.auth.singleton()) }
        : null,
    createBackofficeScopedContext: (scope) => {
      kernel.assertScopedContextAccess(execution, scope);
      return createRouteBackedRuntimeContext({
        runtime,
        kernel,
        execution: {
          actors: execution.actors,
          scope,
          ...(execution.userAuthority ? { userAuthority: execution.userAuthority } : {}),
        },
        emittedEventActors,
        pi,
        workflowSourceFileSystem: backofficeContextScopesEqual(execution.scope, scope)
          ? workflowSourceFileSystem
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
    automation: null,
    cloudflare: runtime.config.bindings.cloudflare
      ? (() => {
          const object = unavailableObject(() => runtime.objects.cloudflare.singleton());
          return object ? { runtime: createCloudflareRuntime({ object }) } : null;
        })()
      : null,
    web: runtime.config.bindings.cloudflare
      ? (() => {
          const object = unavailableObject(() => runtime.objects.cloudflare.singleton());
          return object ? { runtime: createWebRuntime({ object }) } : null;
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
          const fileSystem =
            workflowSourceFileSystem ??
            (await createBackofficeFileSystem({
              objects: runtime.objects,
              config: runtime.config,
              execution,
              kernel,
            }));
          const script = await readAutomationWorkspaceScript(fileSystem, path);
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
    internal: org
      ? {
          runtime: createInternalRuntime({
            objects: runtime.objects,
            config: runtime.config,
            orgId: org.orgId,
            families: runtimeToolFamilies,
          }),
        }
      : null,
    api: runtime.config.bindings.api
      ? (() => {
          const object = unavailableObject(() =>
            kernel.scoped("API", execution.scope, runtime.objects.api),
          );
          return object
            ? {
                runtime: createApiRuntime(object, async () => {
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
                }),
              }
            : null;
        })()
      : null,
    mcp: runtime.config.bindings.mcp
      ? (() => {
          const object = unavailableObject(() =>
            kernel.scoped("MCP", execution.scope, runtime.objects.mcp),
          );
          return object
            ? {
                runtime: createMcpRuntime(object, async () => {
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
                }),
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
                object: kernel.scoped("OTP", execution.scope, runtime.objects.otp),
                config: runtime.config,
                scope: resolvedScope,
                kernel,
                execution,
              }).createClaim(input);
            },
          }
        : createUnavailableOtpRuntime(unavailableMessage("OTP", execution)),
    },
    pi: pi ?? {
      runtime: createPiRouteRuntime({
        object: automationsObject,
        scope: execution.scope,
        execution,
      }),
    },
    reson8: {
      runtime: selectedOrg
        ? createReson8RouteRuntime({
            object: kernel.scoped("RESON8", execution.scope, runtime.objects.reson8),
          })
        : createUnavailableReson8Runtime(unavailableMessage("RESON8", execution)),
    },
    resend: {
      runtime: selectedOrg
        ? createResendRouteRuntime({
            object: kernel.scoped("RESEND", execution.scope, runtime.objects.resend),
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
    upload:
      runtime.config.bindings.upload && isBackofficeRoutableScope(execution.scope)
        ? {
            runtime: createUploadRuntime(
              kernel.scoped("UPLOAD", execution.scope, runtime.objects.upload),
            ),
          }
        : null,
    telegram:
      execution.scope.kind === "org"
        ? {
            runtime: createTelegramRuntime({
              object: kernel.scoped("TELEGRAM", execution.scope, runtime.objects.telegram),
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
