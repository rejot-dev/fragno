import type { BackofficeCodemodeInput } from "@fragno-dev/backoffice-api/v0/codemode";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { codemodeRunnerFor } from "./codemode-object-execute";
import { runBackofficeCodemode } from "./execute";

export async function executeInteractiveCodemode({
  body,
  execution,
  runtime,
  kernel,
}: {
  body: BackofficeCodemodeInput;
  execution: BackofficeExecutionContext;
  runtime: BackofficeRuntimeServices;
  kernel: BackofficeKernel;
}) {
  const toolContext = createBackofficeToolContext(
    createCodemodeRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime,
      kernel,
      execution,
    }),
  );
  const result = await runBackofficeCodemode({
    ...body,
    codemode: codemodeRunnerFor(
      kernel.scoped("CODEMODE", execution.scope, runtime.objects.codemode).commands,
      execution,
    ),
    toolContext,
    families: runtimeToolFamilies,
  });
  return {
    ok: !result.error,
    runId: result.runId,
    result: result.result,
    error: result.error,
    logs: result.logs ?? [],
    toolCalls: result.toolCalls,
    workflowDefinition: result.workflowDefinition,
  };
}
