import { z } from "zod";

import { CODEMODE_LIMITS } from "./codemode-limits";

export type CodemodeToolDescriptor = {
  description?: string;
  inputSchema?: unknown;
  inputMode?: "none" | "value";
  outputSchema?: unknown;
  execute(input: unknown, ...args: unknown[]): unknown;
};

export type ToolProvider = {
  name: string;
  fns?: Record<string, (...args: unknown[]) => unknown>;
  tools?: Record<string, CodemodeToolDescriptor>;
};

export type ResolvedProvider = {
  name: string;
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
};

export type ExecuteResult = {
  result?: unknown;
  error?: string;
  logs?: string[];
  workflowDefinition?: { name: string; options?: unknown };
};

const guestLogsSchema = z
  .array(z.string().max(CODEMODE_LIMITS.maxLogBytes))
  .max(CODEMODE_LIMITS.maxLogs);

/** Even a hand-edited compiled Worker must earn trust at its RPC result boundary. */
export const codemodeWorkerEvaluationSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    result: z.unknown(),
    error: z.null(),
    logs: guestLogsSchema,
    workflowDefinition: z
      .strictObject({ name: z.string().min(1).max(1024), options: z.unknown() })
      .nullable(),
  }),
  z.strictObject({
    ok: z.literal(false),
    result: z.undefined(),
    error: z.string().max(32_768),
    logs: guestLogsSchema,
    workflowDefinition: z.null(),
  }),
]);

/** Distinguishes guest completion from failure without relying on error-message truthiness. */
export type CodemodeWorkerEvaluation = z.infer<typeof codemodeWorkerEvaluationSchema>;

export type DynamicWorkerExecutorOptions = {
  loader: WorkerLoader;
  globalOutbound?: Fetcher | null;
};

export const normalizeCode = (code: string): string => {
  const trimmed = code.trim();
  // The executor injects the snippet as a parenthesized expression: `(<code>)`.
  // A leading `return` is a statement and is a SyntaxError in expression position
  // ("Unexpected token 'return'"), which crashes the worker before it can run.
  // LLMs occasionally emit `return defineWorkflow(...)`, so strip a single leading
  // `return` to keep the snippet runnable.
  return trimmed.replace(/^return\b\s*/u, "");
};

export const sanitizeToolName = (name: string): string => {
  const sanitized = name.replace(/[^a-zA-Z0-9_$]/gu, "_");
  return /^[a-zA-Z_$]/u.test(sanitized) ? sanitized : `_${sanitized}`;
};

export const resolveProvider = (provider: ToolProvider): ResolvedProvider => {
  if (provider.fns) {
    return {
      name: provider.name,
      fns: Object.fromEntries(
        Object.entries(provider.fns).map(([name, fn]) => [
          name,
          async (...args: unknown[]) => await fn(...args),
        ]),
      ),
    };
  }

  return {
    name: provider.name,
    fns: Object.fromEntries(
      Object.entries(provider.tools ?? {}).map(([name, tool]) => [
        name,
        async (...args: unknown[]) => {
          if (tool.inputMode === "none") {
            if (args.length > 0) {
              throw new Error(`Tool '${provider.name}.${name}' does not accept arguments.`);
            }
            return await tool.execute(undefined);
          }
          return await tool.execute(args[0], ...args.slice(1));
        },
      ]),
    ),
  };
};
