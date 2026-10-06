import type { WorkerBundle } from "@fragno-dev/codemode/compiler/worker-bundle";
import type { ResolvedProvider } from "@fragno-dev/codemode/runtime-api";
import { Compile } from "typebox/compile";
import { z } from "zod";

import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ConversationId,
  type Extension,
  type HookApi,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { backofficeContextScopeRouteId } from "@/backoffice-runtime/scope-codec";
import { runBackofficeCompiledModule } from "@/fragno/codemode/compiled-module-execute";
import {
  createBackofficeCodemodeResolvedProviders,
  type BackofficeCodemodeEnv,
} from "@/fragno/codemode/execute";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";
import { jsonValueSchema } from "@/lib/zod/json-value";

import { requirePiStateBackend, type PiRuntimeToolContext } from "./pi-runtime-context";
import { piWorkspaceExtensionMetadataSchema } from "./pi-workspace-extension-metadata";
import {
  piWorkspaceExtensionDiagnosticSchema,
  piWorkspaceExtensionHookResultSchemas,
  piWorkspaceExtensionToolResultSchema,
} from "./pi-workspace-extension-results";
import { createPiWorkspaceExtensionInvocation } from "./pi-workspace-extension-source";

const readPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);
const outputSchema = z.union([
  z
    .string()
    .max(65_536)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 65_536),
  z.instanceof(Uint8Array).refine((value) => value.byteLength <= 65_536),
]);

/** Installs native-shaped callbacks whose code and module state remain inside per-call codemode guests. */
export function createPiWorkspaceExtensionBridge(input: {
  metadata: z.infer<typeof piWorkspaceExtensionMetadataSchema>;
  bundle: WorkerBundle;
  path: string;
  execution: BackofficeExecutionContext;
  env: BackofficeCodemodeEnv;
  createRuntimeToolContext: (context: Context, invocationId: string) => PiRuntimeToolContext;
  authorizeExecution: () => Promise<void>;
}): Extension {
  const { metadata } = input;

  async function invoke(
    request: { key: string; conversationId: ConversationId } & (
      | { operation: "render"; shown: Readonly<Record<string, string>> }
      | { operation: "tool"; arguments: unknown; callId: string }
      | { operation: "hook"; arguments: unknown[]; index: number }
    ),
    api: HookApi | ToolExecutionApi | null,
    context: Context,
  ): Promise<unknown> {
    await input.authorizeExecution();
    context.abortSignal?.throwIfAborted();
    const runtime = input.createRuntimeToolContext(
      context,
      `${metadata.name}:${request.operation}:${request.key}:${api?.taskId ?? request.conversationId}`,
    );
    const state = requirePiStateBackend(runtime);
    function readPath(value: unknown) {
      const absolutePath = state.resolvePath("/workspace", readPathSchema.parse(value));
      if (!absolutePath.startsWith("/workspace/") && !absolutePath.startsWith("/static/")) {
        throw new Error("PI_EXTENSION_READ_PATH_DENIED");
      }
      return absolutePath;
    }
    const providers: ResolvedProvider[] = [
      {
        name: "__piWorkspace",
        fns: {
          readTextFile: async (value) => {
            const path = readPath(value);
            try {
              return { ok: true, value: await state.readFile(path) };
            } catch (error) {
              return {
                ok: false,
                error: {
                  name: "FileError",
                  code: "unknown",
                  message: error instanceof Error ? error.message : String(error),
                },
              };
            }
          },
          exists: async (value) => ({ ok: true, value: await state.exists(readPath(value)) }),
        },
      },
    ];
    if (api !== null) {
      providers.push({
        name: "__piInvocation",
        fns: {
          readMemo: async (name) => await api.memo(z.string().min(1).max(128).parse(name), context),
          writeMemo: async (name, candidate) =>
            await api.memo(
              z.string().min(1).max(128).parse(name),
              jsonValueSchema.parse(candidate),
              context,
            ),
          ...("output" in api
            ? {
                output: async (value: unknown) => {
                  api.output(outputSchema.parse(value));
                },
                diagnostic: async (value: unknown) => {
                  api.diagnostic(piWorkspaceExtensionDiagnosticSchema.parse(value));
                },
                details: async (value: unknown) => {
                  await api.details(jsonValueSchema.parse(value), context);
                },
              }
            : {}),
        },
      });
    }
    if (request.operation === "tool") {
      providers.push(
        ...(await createBackofficeCodemodeResolvedProviders({
          families: runtimeToolFamilies,
          toolContext: createBackofficeToolContext(runtime),
        })),
      );
    }
    // Every provider call rechecks authority and cancellation, not merely the initial guest admission.
    const authorizedProviders = providers.map((provider) => ({
      name: provider.name,
      fns: Object.fromEntries(
        Object.entries(provider.fns).map(([name, fn]) => [
          name,
          async (...args: unknown[]) => {
            await input.authorizeExecution();
            context.abortSignal?.throwIfAborted();
            return await fn(...args);
          },
        ]),
      ),
    }));
    try {
      const value = await runBackofficeCompiledModule({
        bundle: input.bundle,
        invocation: createPiWorkspaceExtensionInvocation(
          providers
            .filter((provider) => !provider.name.startsWith("__"))
            .map((provider) => provider.name),
        ),
        input: {
          ...request,
          taskId: api?.taskId ?? null,
          environmentId: `${input.execution.scope.kind}:${backofficeContextScopeRouteId(input.execution.scope)}`,
        },
        providers: authorizedProviders,
        env: input.env,
        signal: context.abortSignal ?? null,
      });
      // Native results often contain omitted optional properties set to undefined. All other non-JSON data is rejected.
      return copyJson(value as JsonValue, { omitUndefinedProperties: true });
    } catch (error) {
      const prefix =
        request.operation === "render"
          ? "PI_EXTENSION_RENDER_FAILED"
          : request.operation === "tool"
            ? "PI_EXTENSION_TOOL_FAILED"
            : "PI_EXTENSION_HOOK_FAILED";
      throw new Error(
        `${prefix}: ${input.path}#${request.key}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return defineExtension({
    name: metadata.name,
    sections: metadata.sections.map(({ key, tag }) =>
      section(
        key,
        async (prompt, context) => {
          const result = z
            .string()
            .nullable()
            .parse(
              await invoke(
                {
                  operation: "render",
                  key,
                  conversationId: prompt.conversationId,
                  shown: prompt.shown,
                },
                null,
                context,
              ),
            );
          if (result !== null && new TextEncoder().encode(result).byteLength > 65_536) {
            throw new Error(
              `PI_EXTENSION_RENDER_FAILED: ${input.path}#${key}: PI_EXTENSION_SECTION_TOO_LARGE`,
            );
          }
          return result === null ? undefined : result;
        },
        { tag },
      ),
    ),
    tools: metadata.tools.map((tool) => {
      // Compile the received JSON schema before exposing a tool to the model; TypeBox symbols are not transported.
      const parameters = tool.parameters as TSchema;
      Compile(parameters);
      return defineTool({
        name: tool.name,
        description: tool.description,
        parameters,
        replay: tool.replay,
        ...(tool.executionMode === null ? {} : { executionMode: tool.executionMode }),
        ...(tool.outputLimits === null
          ? {}
          : {
              outputLimits: {
                ...(tool.outputLimits.maxBytes === null
                  ? {}
                  : { maxBytes: tool.outputLimits.maxBytes }),
                ...(tool.outputLimits.maxLines === null
                  ? {}
                  : { maxLines: tool.outputLimits.maxLines }),
                ...(tool.outputLimits.retain === null ? {} : { retain: tool.outputLimits.retain }),
              },
            }),
        execute: async (args, api, context) =>
          piWorkspaceExtensionToolResultSchema.parse(
            await invoke(
              {
                operation: "tool",
                key: tool.name,
                arguments: args,
                conversationId: api.conversationId,
                callId: api.callId,
              },
              api,
              context,
            ),
          ),
      });
    }),
    hooks: metadata.hooks.map((registration, index) => ({
      task: registration.task,
      handlers: Object.fromEntries(
        registration.handlers.map((key) => [
          key,
          async (...args: unknown[]) => {
            // These trailing arguments are authoritative native harness collaborators, not guest data.
            const context = args.pop() as Context;
            const api = args.pop() as HookApi;
            const result = piWorkspaceExtensionHookResultSchemas[key].parse(
              await invoke(
                {
                  operation: "hook",
                  key,
                  index,
                  arguments: args,
                  conversationId: api.conversationId,
                },
                api,
                context,
              ),
            );
            return result === null ? undefined : result;
          },
        ]),
      ),
    })),
  });
}
