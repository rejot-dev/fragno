import type { CodemodeRemoteExecutor } from "@fragno-dev/codemode/execution/codemode-activation-contract";
import type { ExecuteResult, ResolvedProvider } from "@fragno-dev/codemode/runtime-api";

import { createBackofficeCodemodeRemoteHost } from "./remote-execution-host";

/** Sends source, not Backoffice capabilities, and preserves immediate result/error behavior. */
export async function runBackofficeRemoteImmediate(input: {
  execute: CodemodeRemoteExecutor;
  kind: "immediate" | "module";
  code: string;
  dependencies: Readonly<Record<string, string>>;
  timeout: number | undefined;
  providers: ResolvedProvider[];
}): Promise<ExecuteResult> {
  const { host, manifest } = createBackofficeCodemodeRemoteHost(input.providers, null);
  try {
    const completion = await input.execute(
      {
        kind: input.kind,
        code: input.code,
        dependencies: input.dependencies,
        timeoutMs: input.timeout ?? 30_000,
        providers: manifest,
      },
      host,
    );
    if (completion.status === "completed") {
      return {
        result: completion.value,
        logs: completion.logs,
        ...(completion.workflowDefinition
          ? { workflowDefinition: completion.workflowDefinition }
          : {}),
      };
    }
    if (completion.status === "failed") {
      return { result: undefined, error: completion.error.message, logs: completion.logs };
    }
    throw new Error("CODEMODE_IMMEDIATE_CANNOT_SUSPEND");
  } catch (error) {
    return {
      result: undefined,
      error: error instanceof Error ? error.message : String(error),
      logs: [],
    };
  } finally {
    host.close();
  }
}
