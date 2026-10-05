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

/** Distinguishes guest completion from failure without relying on error-message truthiness. */
export type CodemodeWorkerEvaluation =
  | {
      ok: true;
      result: unknown;
      error: null;
      logs: string[];
      workflowDefinition: { name: string; options?: unknown } | null;
    }
  | {
      ok: false;
      result: undefined;
      error: string;
      logs: string[];
      workflowDefinition: null;
    };

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
