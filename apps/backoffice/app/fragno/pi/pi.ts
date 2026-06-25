import type { PiSkillRegistryResolver } from "@fragno-dev/pi-fragment/skills";
import { Type, type TSchema } from "typebox";

import { defaultFragnoRuntime } from "@fragno-dev/core";
import {
  createPi,
  createPiFragment,
  createPiWorkflows,
  interactiveChatWorkflow,
  type PiBuilder,
  type PiSystemPromptResolver,
  type PiTool,
} from "@fragno-dev/pi-fragment";
import { buildCodemodeWorkflowGraph } from "@fragno-dev/workflow-visualizer";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import type { BackofficeDatabaseAdapterFactory } from "@/backoffice-runtime/database-adapters";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
import { createBackofficeFileSystem, type MasterFileSystem } from "@/files";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-system-prompt";

import {
  listAutomationScripts,
  runAutomationScript,
  validateAutomationScript,
  writeAutomationScript,
  type AutomationScriptSummary,
  type AutomationValidation,
} from "../automation/authoring";
import type {
  BackofficeCodemodeEnv,
  BackofficeCodemodeExecuteResult,
  RunBackofficeCodemodeInput,
} from "../codemode/execute";
import { createInteractiveBashHost } from "../runtime-tools/automation-host";
import type {
  InteractiveBashCommandContext,
  RegisteredAutomationsRuntime,
} from "../runtime-tools/bash-host";
import type {
  AutomationWorkflowRuntime,
  WorkflowCreateInstanceResult,
} from "../runtime-tools/families/automations-workflow";
import type { OtpRuntime } from "../runtime-tools/families/otp-runtime";
import type { PiRuntime } from "../runtime-tools/families/pi";
import type { ResendRuntime } from "../runtime-tools/families/resend";
import type { Reson8Runtime } from "../runtime-tools/families/reson8";
import type { TelegramRuntime } from "../runtime-tools/families/telegram-runtime";
import { createBackofficeToolContext } from "../runtime-tools/tool-context";
import {
  runtimeToolFamilies,
  type CoreBackofficeToolContext,
} from "../runtime-tools/tool-families";
import type { PiCodemodeWorkflowParams } from "./pi-codemode-workflow";
import {
  PI_MODEL_CATALOG,
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_TOOL_IDS,
  createPiAgentName,
  resolvePiHarnesses,
  type PiHarnessConfig,
  type PiToolId,
  type StoredPiConfig,
} from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";
import { withSinclairSchema } from "./typebox-compat";

export type PiRuntimeFragments = {
  piFragment: ReturnType<typeof createPiFragment>;
  workflowsFragment: ReturnType<typeof createWorkflowsFragment>;
};

export type PiBashCommandContext = InteractiveBashCommandContext & {
  automations: {
    runtime: RegisteredAutomationsRuntime;
  };
  otp: {
    runtime: OtpRuntime;
  };
  pi: {
    runtime: PiRuntime;
  };
  reson8: {
    runtime: Reson8Runtime;
  };
  resend: {
    runtime: ResendRuntime;
  };
  telegram: {
    runtime: TelegramRuntime;
  };
};

export type PiSessionFileSystemContext = {
  orgId: string;
  objects: BackofficeObjectRegistry;
  kernel: BackofficeKernel;
  execution: BackofficeExecutionContext;
};

export type PiCodemodeRuntime = {
  env: BackofficeCodemodeEnv;
  execute(input: RunBackofficeCodemodeInput): Promise<BackofficeCodemodeExecuteResult>;
  workflow?: AutomationWorkflowRuntime;
};

export const bashParametersSchema = withSinclairSchema(
  Type.Object({
    script: Type.String({
      minLength: 1,
      description: "Shell script or command to execute in the sandboxed environment.",
    }),
    cwd: Type.Optional(
      Type.String({ description: "Optional working directory within the virtual filesystem." }),
    ),
  }),
);

const readParametersSchema = withSinclairSchema(
  Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)." }),
    offset: Type.Optional(
      Type.Number({ description: "Line number to start reading from (1-indexed)." }),
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
  }),
);

const execCodeModeParametersSchema = withSinclairSchema(
  Type.Object({
    code: Type.String({
      minLength: 1,
      description:
        "Standalone async arrow function to execute in an isolated dynamic Worker with state.* filesystem tools.",
    }),
  }),
);

const emptyParametersSchema = withSinclairSchema(Type.Object({}));

const automationScriptParametersSchema = withSinclairSchema(
  Type.Object({
    path: Type.String({
      minLength: 1,
      description:
        "Workspace-relative automation path. Workflows end in `.workflow.js` (a `defineWorkflow(...)` file); the event router is `router.cm.js`.",
    }),
    body: Type.String({ minLength: 1, description: "Full script source to validate or write." }),
  }),
);

const showWorkflowParametersSchema = withSinclairSchema(
  Type.Object({
    workflow: Type.String({
      minLength: 1,
      description:
        "The name of the workflow to show (the `name` reported by listAutomations), e.g. `onboarding`.",
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("view"), Type.Literal("edit")], {
        description:
          "`view` (default) opens a read-only graph; `edit` opens the editable workbench. Use `edit` when the user wants to change the workflow.",
      }),
    ),
  }),
);

const runAutomationParametersSchema = withSinclairSchema(
  Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Workspace-relative path of the automation script to run.",
    }),
    eventType: Type.String({
      minLength: 1,
      description: "Trigger event type to synthesize, e.g. `message.received`.",
    }),
    source: Type.Optional(
      Type.String({ description: "Trigger event source. Defaults to `manual`." }),
    ),
    payload: Type.Optional(
      Type.String({ description: "Trigger event payload as a JSON object string (e.g. `{}`)." }),
    ),
  }),
);

const defineTool = <TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> => tool;

const normalizeReadPath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

const applyLineRange = (content: string, offset?: number, limit?: number) => {
  if (offset === undefined && limit === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const startIndex = offset === undefined ? 0 : Math.max(0, Math.trunc(offset) - 1);
  const endIndex = limit === undefined ? undefined : startIndex + Math.max(0, Math.trunc(limit));
  return lines.slice(startIndex, endIndex).join("\n");
};

const createReadTool = (fs: MasterFileSystem): AgentTool =>
  defineTool({
    name: "read",
    label: "Read",
    description:
      "Read a file from the combined Pi session filesystem. Use this to load matching skills from /system/skills/<skill-name>/SKILL.md or /workspace/skills/<skill-name>/SKILL.md before applying them.",
    parameters: readParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Read aborted.");
      }

      const path = normalizeReadPath(params.path);
      const content = await fs.readFile(path, { encoding: "utf-8" });
      const text = applyLineRange(content, params.offset, params.limit);
      return {
        content: [{ type: "text", text }],
        details: {
          path,
          offset: params.offset ?? null,
          limit: params.limit ?? null,
        },
      };
    },
  });

const createBashTool = (
  fs: MasterFileSystem,
  sessionId: string,
  context: PiBashCommandContext,
): AgentTool =>
  defineTool({
    name: "bash",
    label: "Bash",
    description: "Execute bash commands in the combined Pi session filesystem.",
    parameters: bashParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      const { script, cwd } = params;
      if (signal?.aborted) {
        throw new Error("Bash execution aborted.");
      }

      const scriptPreview = script.length > 120 ? `${script.slice(0, 117)}...` : script;
      console.info("Pi bash tool start", {
        sessionId,
        cwd,
        length: script.length,
        preview: scriptPreview,
      });

      const { bash, commandCallsResult } = createInteractiveBashHost({
        fs,
        sessionId,
        context,
      });
      let result: Awaited<ReturnType<typeof bash.exec>>;
      try {
        result = await bash.exec(script, cwd ? { cwd } : { cwd: "/" });
      } catch (error) {
        console.warn("Pi bash tool error", {
          sessionId,
          cwd,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const stdout = result.stdout?.trimEnd() ?? "";
      const stderr = result.stderr?.trimEnd() ?? "";
      const exitCode = result.exitCode ?? 0;

      const outputLines = [stdout, stderr].filter(Boolean);
      if (outputLines.length === 0) {
        outputLines.push(`Command finished with exit code ${exitCode}.`);
      }

      console.info("Pi bash tool end", {
        sessionId,
        exitCode,
      });

      return {
        content: [{ type: "text", text: outputLines.join("\n") }],
        details: {
          stdout,
          stderr,
          exitCode,
          commandCalls: commandCallsResult,
        },
      };
    },
  });

const formatExecCodeModeText = (result: BackofficeCodemodeExecuteResult) => {
  const lines: string[] = [];
  const logs = result.logs ?? [];
  lines.push(...logs);

  if (result.error) {
    lines.push(result.error);
    return lines.join("\n");
  }

  if (result.result === undefined) {
    return lines.join("\n");
  }

  lines.push(
    typeof result.result === "string" ? result.result : (JSON.stringify(result.result) ?? ""),
  );
  return lines.join("\n");
};

const createExecCodeModeTool = (
  fs: MasterFileSystem,
  sessionId: string,
  codemode: PiCodemodeRuntime | undefined,
  bashCommandContext: PiBashCommandContext | undefined,
  orgId: string,
): AgentTool =>
  defineTool({
    name: "execCodeMode",
    label: "Exec Code Mode",
    description:
      "Execute a standalone async arrow function in an isolated dynamic Worker with state.* filesystem tools.",
    parameters: execCodeModeParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      const { code } = params;
      if (signal?.aborted) {
        throw new Error("Codemode execution aborted.");
      }

      if (!codemode) {
        throw new Error("execCodeMode is not configured for this Pi runtime.");
      }

      if (!bashCommandContext) {
        throw new Error("execCodeMode requires a Backoffice runtime context.");
      }

      const context: CoreBackofficeToolContext = createBackofficeToolContext({
        ...bashCommandContext,
        workflow: codemode.workflow ? { runtime: codemode.workflow } : bashCommandContext.workflow,
      });

      const result = await codemode.execute({
        code,
        fs,
        env: codemode.env,
        families: runtimeToolFamilies,
        toolContext: context,
      });

      // Codemode always emits a workflow, so derive its graph here (server-side,
      // where the visualizer's parser is available) — *before* scheduling, since a
      // static parse must survive even when the durable run can't be created. The
      // compose transcript opens this in the companion workflow viewer.
      const workflowGraph = buildCodemodeWorkflowGraph(code, {
        name: result.workflowDefinition?.name,
      });
      const parsedWorkflow = workflowGraph.nodes.some((node) => node.kind === "workflow");

      // Try to schedule the durable run, but treat a scheduling/validation failure
      // as non-fatal: the viewer should still show the workflow the agent wrote.
      let scheduleError: string | undefined;
      // The scheduled run's handle, surfaced to the client so the workflow viewer
      // can subscribe to its live progress (history/status + step emissions).
      let runHandle: WorkflowCreateInstanceResult | undefined;
      if (result.workflowDefinition) {
        if (!codemode.workflow) {
          scheduleError = "execCodeMode workflow definition cannot be scheduled in this runtime.";
        } else {
          try {
            // The workflows backend requires instance ids to match
            // /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/ (≤128 chars). Tool-call ids contain a
            // `|` (`call_…|fc_…`), so sanitize and cap, or scheduling 400s.
            const instanceId = `${sessionId}--${_toolCallId}`
              .replaceAll(/[^A-Za-z0-9_-]/g, "-")
              .slice(0, 128);
            runHandle = await codemode.workflow.createInstance({
              workflowName: "pi-codemode-script",
              remoteWorkflowName: result.workflowDefinition.name,
              instanceId,
              params: {
                orgId,
                code,
                sessionId,
                toolCallId: _toolCallId,
              } satisfies PiCodemodeWorkflowParams,
            });
            result.result = runHandle;
          } catch (error) {
            scheduleError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      const text = scheduleError
        ? `${formatExecCodeModeText(result)}\n\nWorkflow could not be scheduled: ${scheduleError}`
        : formatExecCodeModeText(result);

      // Only a genuine failure with no recognizable workflow is a hard tool error
      // (a thrown error loses `details`, which would hide the workflow from the
      // viewer). When the code parsed into a workflow, keep the result successful
      // and carry the graph, surfacing any run/scheduling error in the text so the
      // model can still react and retry.
      if ((result.error || scheduleError) && !parsedWorkflow) {
        throw new Error(text);
      }

      return {
        content: [{ type: "text", text }],
        details: {
          ...result,
          code,
          workflowGraph,
          outputText: text,
          // The live run handle (workflow name + instance id) so the client can
          // subscribe to realtime progress. Absent when scheduling failed.
          ...(runHandle ? { run: runHandle } : {}),
          ...(scheduleError ? { scheduleError } : {}),
        },
      };
    },
  });

const formatAutomationScriptLine = (script: AutomationScriptSummary): string => {
  const shape = script.workflows.length
    ? script.workflows
        .map((wf) => `${wf.name} (${wf.stepCount} step${wf.stepCount === 1 ? "" : "s"})`)
        .join(", ")
    : script.kind;
  const flags = script.readOnly ? " [read-only]" : "";
  return `- ${script.path} [${script.engine}] ${shape}${flags}`;
};

const formatAutomationValidation = (validation: AutomationValidation): string => {
  const lines: string[] = [
    `${validation.ok ? "OK" : "BLOCKED"} ${validation.path} [${validation.engine}] kind=${validation.summary.kind}`,
  ];
  for (const wf of validation.summary.workflows) {
    lines.push(`  workflow ${wf.name}: ${wf.steps.join(" -> ") || "(no steps)"}`);
  }
  if (validation.diagnostics.length === 0) {
    lines.push("  no diagnostics");
  } else {
    for (const diagnostic of validation.diagnostics) {
      const loc = diagnostic.path
        ? ` (${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ""})`
        : "";
      lines.push(`  ${diagnostic.severity}: ${diagnostic.message}${loc}`);
    }
  }
  return lines.join("\n");
};

const createListAutomationsTool = (fs: MasterFileSystem): AgentTool =>
  defineTool({
    name: "listAutomations",
    label: "List Automations",
    description:
      "List the workspace automation scripts (the event router and workflow files) with their parsed step shape.",
    parameters: emptyParametersSchema,
    execute: async (_toolCallId, _params, signal) => {
      if (signal?.aborted) {
        throw new Error("List automations aborted.");
      }
      const scripts = await listAutomationScripts(fs);
      const text = scripts.length
        ? scripts.map(formatAutomationScriptLine).join("\n")
        : "No workspace automations yet.";
      return { content: [{ type: "text", text }], details: { scripts } };
    },
  });

const createShowWorkflowTool = (fs: MasterFileSystem): AgentTool =>
  defineTool({
    name: "showWorkflow",
    label: "Show Workflow",
    description:
      "Open a workflow in the companion panel beside the conversation so the user can see its graph and source. Use this whenever the user asks to view or edit a workflow. Pass the workflow name as reported by listAutomations (the file path also works).",
    parameters: showWorkflowParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Show workflow aborted.");
      }
      // Resolve the request to a canonical workflow *name* — accepting either the
      // name or the script path/filename, since models reach for either. The
      // panel loads the graph by name; this tool resolves and confirms it so the
      // client opens the right one and the agent gets clear feedback otherwise.
      const mode = params.mode === "edit" ? "edit" : "view";
      const scripts = await listAutomationScripts(fs);
      const names = scripts.flatMap((script) => script.workflows.map((workflow) => workflow.name));

      const basename = (value: string) => value.split("/").pop() ?? value;
      const byPath = new Map<string, string>();
      for (const script of scripts) {
        const firstWorkflow = script.workflows[0]?.name;
        if (firstWorkflow) {
          byPath.set(script.path, firstWorkflow);
          byPath.set(basename(script.path), firstWorkflow);
        }
      }

      const input = params.workflow;
      const matched =
        names.find((name) => name === input) ??
        names.find((name) => name.toLowerCase() === input.toLowerCase()) ??
        byPath.get(input) ??
        byPath.get(basename(input));

      if (!matched) {
        const known = names.length ? names.join(", ") : "none";
        return {
          content: [
            {
              type: "text",
              text: `No workflow named "${input}" was found. Known workflows: ${known}.`,
            },
          ],
          details: { workflow: input, found: false, mode, known: names },
        };
      }

      return {
        content: [{ type: "text", text: `Showing "${matched}" in the workflow panel (${mode}).` }],
        details: { workflow: matched, found: true, mode, known: names },
      };
    },
  });

const createValidateAutomationTool = (fs: MasterFileSystem): AgentTool =>
  defineTool({
    name: "validateAutomation",
    label: "Validate Automation",
    description:
      "Parse an automation script body WITHOUT writing it. Returns diagnostics and the parsed step graph. Always run this before writeAutomation.",
    parameters: automationScriptParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Validate automation aborted.");
      }
      const validation = await validateAutomationScript(fs, {
        path: params.path,
        body: params.body,
      });
      return {
        content: [{ type: "text", text: formatAutomationValidation(validation) }],
        details: validation,
      };
    },
  });

const createWriteAutomationTool = (fs: MasterFileSystem): AgentTool =>
  defineTool({
    name: "writeAutomation",
    label: "Write Automation",
    description:
      "Validate and write an automation script into /workspace/automations. Refuses to write if the script has error-level diagnostics; system scripts are read-only.",
    parameters: automationScriptParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Write automation aborted.");
      }
      const result = await writeAutomationScript(fs, { path: params.path, body: params.body });
      if (!result.ok) {
        const detail = result.validation
          ? `\n${formatAutomationValidation(result.validation)}`
          : "";
        throw new Error(`${result.error}${detail}`);
      }
      const text = `${result.created ? "Created" : "Updated"} ${result.validation.path}.\n${formatAutomationValidation(
        result.validation,
      )}`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

const parseRunPayload = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
};

const createRunAutomationTool = (
  fs: MasterFileSystem,
  codemode: PiCodemodeRuntime | undefined,
  bashCommandContext: PiBashCommandContext | undefined,
  orgId: string,
): AgentTool =>
  defineTool({
    name: "runAutomation",
    label: "Run Automation",
    description:
      "Run an authored automation script with a synthetic trigger event and return the created instance id (use the workflows route to follow its progress).",
    parameters: runAutomationParametersSchema,
    execute: async (_toolCallId, params, signal) => {
      if (signal?.aborted) {
        throw new Error("Run automation aborted.");
      }
      const runtime = codemode?.workflow ?? bashCommandContext?.workflow?.runtime;
      if (!runtime) {
        throw new Error(
          "runAutomation is not configured for this Pi runtime (no workflow runtime).",
        );
      }
      const payload = parseRunPayload(params.payload);
      const result = await runAutomationScript(fs, runtime, {
        orgId,
        path: params.path,
        source: params.source,
        eventType: params.eventType,
        payload,
      });
      const text = `Started ${result.scriptPath} as instance ${result.instanceId} (workflow ${result.workflowName}).`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

const getSessionFs = async (
  cache: Map<string, Promise<MasterFileSystem>>,
  sessionId: string,
  context: PiSessionFileSystemContext,
) => {
  const existing = cache.get(sessionId);
  if (existing) {
    return existing;
  }

  const pendingFileSystem = createBackofficeFileSystem({
    objects: context.objects,
    kernel: context.kernel,
    execution: context.execution,
  });

  cache.set(sessionId, pendingFileSystem);

  try {
    return await pendingFileSystem;
  } catch (error) {
    cache.delete(sessionId);
    throw error;
  }
};

export const createPiToolRegistry = ({
  sessionFileSystems,
  sessionFileSystemContext,
  env,
  codemode,
  bashCommandContext,
}: {
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  env?: CloudflareEnv;
  codemode?: PiCodemodeRuntime;
  bashCommandContext?: PiBashCommandContext;
}): Record<PiToolId, PiTool> => ({
  read: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createReadTool(fileSystem);
  },
  bash: async ({ session }) => {
    if (!bashCommandContext || !env) {
      throw new Error("bash is not configured for this Pi runtime.");
    }

    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createBashTool(fileSystem, session.id, bashCommandContext);
  },
  execCodeMode: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createExecCodeModeTool(
      fileSystem,
      session.id,
      codemode,
      bashCommandContext,
      sessionFileSystemContext.orgId,
    );
  },
  listAutomations: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createListAutomationsTool(fileSystem);
  },
  showWorkflow: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createShowWorkflowTool(fileSystem);
  },
  validateAutomation: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createValidateAutomationTool(fileSystem);
  },
  writeAutomation: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createWriteAutomationTool(fileSystem);
  },
  runAutomation: async ({ session }) => {
    const fileSystem = await getSessionFs(sessionFileSystems, session.id, sessionFileSystemContext);
    return createRunAutomationTool(
      fileSystem,
      codemode,
      bashCommandContext,
      sessionFileSystemContext.orgId,
    );
  },
});

const resolveApiKey = (config: StoredPiConfig, provider: string): string | undefined => {
  switch (provider) {
    case "openai":
      return config.apiKeys.openai;
    case "anthropic":
      return config.apiKeys.anthropic;
    case "google":
      return config.apiKeys.gemini;
    default:
      return undefined;
  }
};

const createBackofficePiBuilder = (tools: Record<PiToolId, PiTool>) =>
  createPi()
    .withTool("bash", tools.bash)
    .withTool("execCodeMode", tools.execCodeMode)
    .withTool("read", tools.read)
    .withTool("listAutomations", tools.listAutomations)
    .withTool("showWorkflow", tools.showWorkflow)
    .withTool("validateAutomation", tools.validateAutomation)
    .withTool("writeAutomation", tools.writeAutomation)
    .withTool("runAutomation", tools.runAutomation)
    .withWorkflow(interactiveChatWorkflow)
    .logging({ enabled: true, level: "debug" });

type BackofficePiBuilder = PiBuilder<Record<string, never>, Record<PiToolId, PiTool>>;

const createBackofficePiSkillResolver =
  (options: {
    sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
    sessionFileSystemContext: PiSessionFileSystemContext;
  }): PiSkillRegistryResolver =>
  async ({ sessionId }) => {
    const fileSystem = await getSessionFs(
      options.sessionFileSystems,
      sessionId,
      options.sessionFileSystemContext,
    );
    return loadBackofficePiSkills(fileSystem);
  };

const createBackofficePiSystemPromptResolver =
  (options: {
    sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
    sessionFileSystemContext: PiSessionFileSystemContext;
  }): PiSystemPromptResolver =>
  async ({ sessionId, baseSystemPrompt }) => {
    const fileSystem = await getSessionFs(
      options.sessionFileSystems,
      sessionId,
      options.sessionFileSystemContext,
    );
    return await renderCodemodeSystemPrompt({ fileSystem, guidance: baseSystemPrompt });
  };

const buildPiRuntime = (
  config: StoredPiConfig,
  tools: Record<PiToolId, PiTool>,
  skills: PiSkillRegistryResolver,
  resolveSystemPrompt: PiSystemPromptResolver,
) => {
  const builder = createBackofficePiBuilder(tools);

  const harnesses = resolvePiHarnesses(config.harnesses);
  for (const harness of harnesses) {
    registerHarnessAgents(builder, harness, config);
  }

  const runtime = builder.build();

  return {
    config: runtime.config,
    workflows: createPiWorkflows({
      agents: runtime.config.agents,
      tools,
      skills,
      resolveSystemPrompt,
      workflows: runtime.config.workflows,
      logging: runtime.config.logging,
    }),
  };
};

const registerHarnessAgents = (
  builder: BackofficePiBuilder,
  harness: PiHarnessConfig,
  config: StoredPiConfig,
) => {
  for (const option of PI_MODEL_CATALOG) {
    const modelProvider = PI_PROVIDER_TO_MODEL_PROVIDER[option.provider];
    const model = getModel(modelProvider, option.name as never);
    if (!model) {
      console.warn("Pi model missing from registry", {
        provider: option.provider,
        model: option.name,
      });
      continue;
    }

    const agentName = createPiAgentName({
      harnessId: harness.id,
      provider: option.provider,
      model: option.name,
    });

    builder.withAgent(agentName, {
      systemPrompt: harness.systemPrompt,
      model,
      tools: resolveHarnessAgentTools(harness),
      skills: "all",
      toolConfig: harness.toolConfig,
      thinkingLevel: harness.thinkingLevel,
      getApiKey: (provider) => resolveApiKey(config, provider),
    });
  }
};

const resolveHarnessAgentTools = (harness: PiHarnessConfig): PiToolId[] => {
  const tools = harness.tools.filter(isValidPiToolId);
  if (tools.includes("read")) {
    return tools;
  }
  return [...tools, "read"];
};

const isValidPiToolId = (toolId: string): toolId is (typeof PI_TOOL_IDS)[number] =>
  PI_TOOL_IDS.includes(toolId as (typeof PI_TOOL_IDS)[number]);

export const createPiRuntime = (options: {
  config: StoredPiConfig;
  adapters: BackofficeDatabaseAdapterFactory;
  orgId: string;
  env: CloudflareEnv;
  sessionFileSystems: Map<string, Promise<MasterFileSystem>>;
  sessionFileSystemContext: PiSessionFileSystemContext;
  bashCommandContext: PiBashCommandContext;
  codemode: PiCodemodeRuntime;
}): PiRuntimeFragments => {
  const adapter = options.adapters.createAdapter({
    kind: "pi",
  });
  const codemode = options.codemode;
  const tools = createPiToolRegistry({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
    env: options.env,
    codemode,
    bashCommandContext: options.bashCommandContext,
  });
  const skills = createBackofficePiSkillResolver({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
  });
  const resolveSystemPrompt = createBackofficePiSystemPromptResolver({
    sessionFileSystems: options.sessionFileSystems,
    sessionFileSystemContext: options.sessionFileSystemContext,
  });
  const pi = buildPiRuntime(options.config, tools, skills, resolveSystemPrompt);

  const workflowsFragment = createWorkflowsFragment(
    {
      workflows: pi.workflows,
      runtime: defaultFragnoRuntime,
    },
    {
      databaseAdapter: adapter,
      mountRoute: "/api/pi-workflows",
    },
  );

  const piFragment = createPiFragment(
    pi.config,
    {
      databaseAdapter: adapter,
      mountRoute: "/api/pi",
    },
    {
      workflows: workflowsFragment.services,
    },
  );

  return {
    piFragment,
    workflowsFragment,
  };
};

export { createPiRouteRuntime } from "../runtime-tools/families/pi-runtime";
