import { z } from "zod";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import { codemodeRunnerFor } from "./codemode-object-execute";
import { runBackofficeCodemode } from "./execute";

export const backofficeCodemodeInputSchema = z.strictObject({
  code: z.string().min(1),
  dependencies: z.record(z.string().min(1), z.string().min(1)).optional(),
  // Long-running Pi turns can exceed two minutes while their workflow continues streaming.
  timeout: z.number().int().positive().max(300_000).optional(),
});

export async function executeInteractiveCodemode({
  body,
  execution,
  runtime,
  kernel,
}: {
  body: z.infer<typeof backofficeCodemodeInputSchema>;
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
