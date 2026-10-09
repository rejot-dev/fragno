import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";

import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  section,
  type AnyTask,
  type HarnessOptions,
} from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createPiManagerRuntime } from "@/fragno/pi-manager/pi-manager-runtime";
import { buildBackofficePiSystemPrompt } from "@/fragno/pi/pi-agent-environment";
import {
  createPiCodemodeRuntime,
  createUnavailablePiCodemodeRuntime,
} from "@/fragno/pi/pi-codemode";
import type { PiRuntimeToolContext } from "@/fragno/pi/pi-runtime-context";
import { createBackofficePiTools } from "@/fragno/pi/pi-tools";
import { loadPiWorkspaceExtensions } from "@/fragno/pi/pi-workspace-extensions";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { createAuthorizedPiDurableModels } from "./pi-durable-authorized-models";

/** Rebuilds the scoped Backoffice environment from persisted provenance after every agent restart. */
export async function createBackofficePiDurableHarnessOptions(input: {
  config: PiAgentConfig;
  runtime: BackofficeRuntimeServices;
  options: HarnessOptions;
  tasks: readonly AnyTask[];
}): Promise<HarnessOptions> {
  const { config, options, tasks } = input;
  // Persisted route actors carry identity, not grants; every model and tool call needs live authority.
  const runtime = input.runtime;
  const kernel = new BackofficeKernel(runtime);
  const execution: BackofficeExecutionContext = {
    kind: "deferred",
    scope: config.scope,
    scopeRestriction: config.scopeRestriction,
    actors: config.actors,
  };
  const codemode = runtime.codemodeEnv
    ? createPiCodemodeRuntime(runtime.codemodeEnv)
    : createUnavailablePiCodemodeRuntime();

  async function authorizeExecution() {
    if (config.scope.kind === "user" && config.billingOrganizationId === null) {
      throw new Error(
        "PI_BILLING_OWNER_REQUIRED: user-scoped Pi sessions require a billing organization.",
      );
    }
    await kernel.assertAuthorized({
      execution,
      operation: BACKOFFICE_PERMISSION.pi.modify,
      resource: { kind: "pi-agent-execution", sessionId: config.sessionId },
    });
    if (
      config.billingOrganizationId !== null &&
      (config.scope.kind === "user" || config.scope.kind === "system")
    ) {
      await kernel.assertAuthorized({
        execution: { ...execution, scope: { kind: "org", orgId: config.billingOrganizationId } },
        operation: BACKOFFICE_PERMISSION.pi.modify,
        resource: { kind: "pi-agent-billing", sessionId: config.sessionId },
      });
    }
  }

  function createToolContext(invocationId: string, context: Context): PiRuntimeToolContext {
    let promptIndex = 0;
    const createPromptRequestId = () => `${invocationId}:${promptIndex++}`;
    return createRouteBackedRuntimeContext({
      runtime,
      kernel,
      execution,
      billingOrganizationId: config.billingOrganizationId,
      // A factory follows scope changes; a fixed runtime would leak the parent directory into child contexts.
      pi: (scopedExecution) => ({
        runtime: createPiManagerRuntime({
          runtime,
          kernel,
          execution: scopedExecution,
          defaultBillingOrganizationId: config.billingOrganizationId,
          createPromptRequestId,
          context,
        }),
      }),
    }) as PiRuntimeToolContext;
  }

  const promptContext = createToolContext(config.sessionId, BACKGROUND_CONTEXT);
  const tools = Object.values(
    createBackofficePiTools({
      sessionId: config.sessionId,
      execution,
      billingOrganizationId: config.billingOrganizationId,
      codemode,
      authorizeExecution,
      createRuntimeToolContext: ({ invocationId, context }) =>
        createToolContext(invocationId, context),
    }),
  );
  const registry = createRegistry();
  for (const extension of options.registry.snapshot().installed()) {
    registry.install(extension);
  }
  registry.install(
    defineExtension({
      name: "backoffice",
      tools,
      tasks,
      sections: [
        section(
          "backoffice",
          async () => {
            await authorizeExecution();
            return await buildBackofficePiSystemPrompt({ runtimeToolContext: promptContext });
          },
          { tag: false },
        ),
      ],
    }),
  );
  const report =
    options.onReport ??
    ((error: unknown) => {
      console.error(error);
    });
  for (const extension of await loadPiWorkspaceExtensions({
    execution,
    createRuntimeToolContext: (context, invocationId) =>
      createToolContext(`${config.sessionId}:${invocationId}`, context),
    env: runtime.codemodeEnv ?? null,
    registry: registry.snapshot(),
    authorizeExecution,
    report,
  })) {
    registry.install(extension);
  }
  return {
    ...options,
    onReport: report,
    // Pi isolates failures in prompt sections and hooks, so only the model boundary can fail closed.
    models: createAuthorizedPiDurableModels(options.models, authorizeExecution),
    registry,
    settings: { ...options.settings, stream: { maxRetries: 3, ...options.settings?.stream } },
  };
}
