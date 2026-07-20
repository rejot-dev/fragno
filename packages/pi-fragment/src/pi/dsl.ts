import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import {
  NonRetryableError,
  type WorkflowDefinition,
  type WorkflowDuration,
  type WorkflowEvent,
  type WorkflowsRegistry,
  type WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowStepConsumeTx,
} from "@fragno-dev/workflows/workflow";
import type { TSchema as TypeBoxSchema } from "typebox";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createPiWorkflows } from "./factory";
import {
  PiSkillDefinitionBuilder,
  renderPiSkillCatalogXml,
  renderPiSkillInvocationContext,
  type PiSkillDefinition,
  type PiSkillDefinitionInput,
  type PiSkillRegistry,
  type PiSkillRegistrySource,
} from "./skills";
import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiFragmentConfig,
  PiPromptInput,
  PiSystemPromptResolver,
  PiTool,
  PiToolDefinition,
  PiToolRegistry,
} from "./types";
import type { PiSessionCommandPayload } from "./types";
import {
  runPiAgentStep,
  type PiAgentRunner,
  type PiAgentStepResult,
} from "./workflow/pi-agent-step";

export type PiWorkflowAgentStepHandle = {
  run(name: string, options: PiWorkflowAgentRunOptions): Promise<PiAgentStepResult>;
  prompt(name: string, options: PiWorkflowAgentPromptOptions): Promise<PiAgentStepResult>;
  continue(name: string, options?: PiWorkflowAgentStepOptions): Promise<PiAgentStepResult>;
  skill(name: string, options: PiWorkflowAgentSkillOptions): Promise<PiAgentStepResult>;
};

export type PiWorkflowAgentRunOptions = PiWorkflowAgentStepOptions & {
  mode: "prompt" | "continue";
  input?: PiPromptInput;
};

export type PiWorkflowAgentPromptOptions = PiWorkflowAgentStepOptions & {
  input: PiPromptInput;
};

export type PiWorkflowAgentSkillOptions = PiWorkflowAgentStepOptions & {
  skill: string | PiSkillDefinition;
  input?: PiPromptInput;
};

export type PiWorkflowAgentStepOptions = {
  messages?: AgentMessage[];
  systemPrompt?: string;
  skill?: string | PiSkillDefinition;
  extraInstructions?: string;
  step?: WorkflowStepConfig;
  controls?: Array<"abort" | "steer">;
  stopOnTools?: Array<string | PiToolDefinition>;
  toolExecution?: "sequential" | "parallel";
  turnId?: string;
};

export type PiWorkflowCommandWaitOptions = {
  allowed?: PiSessionCommandPayload["kind"][];
  timeout?: WorkflowDuration;
  onConsume?: (tx: WorkflowStepConsumeTx, command: PiSessionCommandPayload) => Promise<void> | void;
};

export type PiWorkflowContext<TParams = unknown> = Omit<WorkflowStep, "waitForEvent"> & {
  params: TParams;
  sessionId: string;
  event: WorkflowEvent<TParams>;
  step: WorkflowStep;
  agentStep(name: string): PiWorkflowAgentStepHandle;
  waitForEvent(
    name: string,
    options?: PiWorkflowCommandWaitOptions,
  ): Promise<PiSessionCommandPayload>;
};

export type PiWorkflowRunFn<TParams = unknown, TOutput = unknown> = (
  ctx: PiWorkflowContext<TParams>,
) => Promise<TOutput> | TOutput;

export type PiWorkflowDefinition<
  TName extends string = string,
  TParams = unknown,
  TOutput = unknown,
  TInputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> = {
  name: TName;
  schema?: TInputSchema;
  outputSchema?: TOutputSchema;
  run(ctx: PiWorkflowContext<TParams>): Promise<TOutput> | TOutput;
};

export function definePiWorkflow<TName extends string, TParams, TOutput = unknown>(
  options: { name: TName; schema?: undefined; outputSchema?: undefined },
  run: PiWorkflowRunFn<TParams, TOutput>,
): PiWorkflowDefinition<TName, TParams, TOutput, undefined, undefined>;
export function definePiWorkflow<
  TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput = unknown,
>(
  options: { name: TName; schema: TSchema; outputSchema?: undefined },
  run: PiWorkflowRunFn<StandardSchemaV1.InferOutput<TSchema>, TOutput>,
): PiWorkflowDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, TOutput, TSchema, undefined>;
export function definePiWorkflow<
  TName extends string,
  TOutputSchema extends StandardSchemaV1,
  TParams = unknown,
>(
  options: { name: TName; schema?: undefined; outputSchema: TOutputSchema },
  run: PiWorkflowRunFn<TParams, StandardSchemaV1.InferOutput<TOutputSchema>>,
): PiWorkflowDefinition<
  TName,
  TParams,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  undefined,
  TOutputSchema
>;
export function definePiWorkflow<
  TName extends string,
  TInputSchema extends StandardSchemaV1,
  TOutputSchema extends StandardSchemaV1,
>(
  options: { name: TName; schema: TInputSchema; outputSchema: TOutputSchema },
  run: PiWorkflowRunFn<
    StandardSchemaV1.InferOutput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>
  >,
): PiWorkflowDefinition<
  TName,
  StandardSchemaV1.InferOutput<TInputSchema>,
  StandardSchemaV1.InferOutput<TOutputSchema>,
  TInputSchema,
  TOutputSchema
>;
export function definePiWorkflow<TName extends string>(
  options: { name: TName; schema?: StandardSchemaV1; outputSchema?: StandardSchemaV1 },
  run: PiWorkflowRunFn,
): PiWorkflowDefinition<TName> {
  return { ...options, run };
}

export type CompilePiWorkflowOptions = {
  agents?: PiAgentRegistry;
  tools?: PiToolRegistry;
  skills?: PiSkillRegistrySource;
  agentRunner?: PiAgentRunner;
  resolveSystemPrompt?: PiSystemPromptResolver;
};

const stopOnToolNames = (tools: Array<string | PiToolDefinition> | undefined) =>
  tools?.map((tool) => (typeof tool === "string" ? tool : tool.name));

const PI_SKILL_CATALOG_SYSTEM_PROMPT_INTRO =
  "The following skills provide specialized instructions for specific tasks. " +
  "When a task matches a skill's description, use that skill before proceeding.";

const resolveSkillRegistry = async (
  skills: PiSkillRegistrySource | undefined,
  context: {
    agentName: string;
    workflowName: string;
    sessionId: string;
    turnId: string;
  },
): Promise<PiSkillRegistry | undefined> => {
  if (!skills) {
    return undefined;
  }
  return typeof skills === "function" ? await skills(context) : skills;
};

const resolveAgentSkills = async (
  agent: PiAgentDefinition,
  skills: PiSkillRegistrySource | undefined,
  context: {
    agentName: string;
    workflowName: string;
    sessionId: string;
    turnId: string;
  },
): Promise<PiSkillDefinition[]> => {
  const selectedSkills = agent.skills;
  if (!selectedSkills || selectedSkills.length === 0) {
    return [];
  }

  const registry = await resolveSkillRegistry(skills, context);
  if (!registry) {
    return [];
  }

  if (selectedSkills === "all") {
    return Object.values(registry);
  }

  const seen = new Set<string>();
  return selectedSkills.flatMap((name) => {
    if (seen.has(name)) {
      return [];
    }
    seen.add(name);

    const skill = registry[name];
    if (!skill) {
      throw new NonRetryableError(`Skill '${name}' not found.`);
    }
    return [skill];
  });
};

const appendSkillCatalogToSystemPrompt = (
  systemPrompt: string,
  skills: readonly PiSkillDefinition[],
) => {
  const skillCatalog = renderPiSkillCatalogXml(skills);
  if (!skillCatalog) {
    return systemPrompt;
  }

  return `${systemPrompt.trimEnd()}\n\n${PI_SKILL_CATALOG_SYSTEM_PROMPT_INTRO}\n${skillCatalog}`;
};

const resolveSkillInvocation = (input: {
  skill: string | PiSkillDefinition;
  agentName: string;
  agentSkills: readonly PiSkillDefinition[];
}): PiSkillDefinition => {
  if (typeof input.skill !== "string") {
    return input.skill;
  }

  const skill = input.agentSkills.find((agentSkill) => agentSkill.name === input.skill);
  if (!skill) {
    throw new NonRetryableError(
      `Skill '${input.skill}' is not available to agent '${input.agentName}'.`,
    );
  }
  return skill;
};

const appendSkillInvocationMessage = (input: {
  messages: AgentMessage[];
  agentName: string;
  agentSkills: readonly PiSkillDefinition[];
  runOptions: PiWorkflowAgentRunOptions;
}): AgentMessage[] => {
  if (!input.runOptions.skill) {
    return input.messages;
  }

  const skill = resolveSkillInvocation({
    skill: input.runOptions.skill,
    agentName: input.agentName,
    agentSkills: input.agentSkills,
  });
  const text = renderPiSkillInvocationContext(skill, {
    extraUserInstructions: input.runOptions.extraInstructions,
  });

  return [
    ...input.messages,
    {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  ];
};

export const compilePiWorkflow = <
  TName extends string,
  TParams,
  TOutput,
  TInputSchema extends StandardSchemaV1 | undefined,
  TOutputSchema extends StandardSchemaV1 | undefined,
>(
  definition: PiWorkflowDefinition<TName, TParams, TOutput, TInputSchema, TOutputSchema>,
  options: CompilePiWorkflowOptions = {},
): WorkflowDefinition<TParams, TOutput, TInputSchema, TOutputSchema, TName> => {
  const run = (event: WorkflowEvent<TParams>, step: WorkflowStep) => {
    const agentStep = (agentName: string): PiWorkflowAgentStepHandle => {
      const agent = options.agents?.[agentName];
      if (!agent) {
        throw new NonRetryableError(`Agent ${agentName} not found.`);
      }

      const runAgentStep = (name: string, runOptions: PiWorkflowAgentRunOptions) => {
        return runPiAgentStep(
          { mode: runOptions.mode, promptInput: runOptions.input },
          {
            event,
            step,
            stepName: name,
            agent,
            agentRunner: options.agentRunner,
            session: {
              sessionId: event.instanceId,
              agentName,
              workflowName: definition.name,
            },
            turn: {
              tools: options.tools ?? {},
              messages: runOptions.messages ?? [],
              turnId: runOptions.turnId ?? `${event.instanceId}:${name}`,
            },
          },
          {
            step: runOptions.step,
            controls: runOptions.controls,
            stopOnTools: stopOnToolNames(runOptions.stopOnTools),
            toolExecution: runOptions.toolExecution,
            prepareRuntime: async (runtime) => {
              const turnId = runOptions.turnId ?? `${event.instanceId}:${name}`;
              const promptContext = {
                agentName,
                workflowName: definition.name,
                sessionId: event.instanceId,
                turnId,
              };
              const agentSkills = await resolveAgentSkills(agent, options.skills, promptContext);
              const baseSystemPrompt = runOptions.systemPrompt ?? agent.systemPrompt;
              const resolvedSystemPrompt = options.resolveSystemPrompt
                ? await options.resolveSystemPrompt({ ...promptContext, baseSystemPrompt })
                : baseSystemPrompt;
              const systemPrompt = agentSkills.length
                ? appendSkillCatalogToSystemPrompt(resolvedSystemPrompt, agentSkills)
                : resolvedSystemPrompt;
              const messages = appendSkillInvocationMessage({
                messages: runOptions.messages ?? [],
                agentName,
                agentSkills,
                runOptions,
              });

              return {
                ...runtime,
                session: {
                  ...runtime.session,
                  systemPrompt,
                },
                turn: {
                  ...runtime.turn,
                  messages,
                },
              };
            },
          },
        );
      };

      return {
        run: runAgentStep,
        prompt: (name, promptOptions) => runAgentStep(name, { ...promptOptions, mode: "prompt" }),
        continue: (name, continueOptions = {}) =>
          runAgentStep(name, { ...continueOptions, mode: "continue" }),
        skill: (name, skillOptions) =>
          runAgentStep(name, {
            ...skillOptions,
            mode: skillOptions.input ? "prompt" : "continue",
          }),
      };
    };

    const waitForCommand = async (
      name: string,
      waitOptions?: PiWorkflowCommandWaitOptions,
    ): Promise<PiSessionCommandPayload> => {
      for (let ignoredCommands = 0; ; ignoredCommands += 1) {
        const commandEvent = await step.waitForEvent<PiSessionCommandPayload>(
          ignoredCommands === 0 ? name : `${name}-${ignoredCommands}`,
          {
            type: "command",
            timeout: waitOptions?.timeout,
            onConsume: waitOptions?.onConsume
              ? (tx, event) => {
                  if (!waitOptions.allowed || waitOptions.allowed.includes(event.payload.kind)) {
                    return waitOptions.onConsume?.(tx, event.payload);
                  }
                }
              : undefined,
          },
        );
        const command = commandEvent.payload;
        if (!waitOptions?.allowed || waitOptions.allowed.includes(command.kind)) {
          return command;
        }
      }
    };

    return definition.run({
      params: event.payload,
      sessionId: event.instanceId,
      event,
      step,
      do: step.do.bind(step),
      sleep: step.sleep.bind(step),
      sleepUntil: step.sleepUntil.bind(step),
      agentStep,
      waitForEvent: waitForCommand,
    });
  };

  return {
    name: definition.name,
    schema: definition.schema,
    outputSchema: definition.outputSchema,
    run,
  };
};

export {
  createPiSkillActivationTool,
  PiSkillDefinitionBuilder,
  renderPiSkillCatalogXml,
  renderPiSkillInvocationContext,
} from "./skills";
export type {
  CreatePiSkillActivationToolOptions,
  PiAgentSkillSelection,
  PiSkillActivationDetails,
  PiSkillCatalogXmlInput,
  PiSkillDefinition,
  PiSkillDefinitionInput,
  PiSkillInvocationContextOptions,
  PiSkillRegistry,
  PiSkillRegistryResolver,
  PiSkillRegistrySource,
  PiSkillResource,
} from "./skills";
export type { PiTool, PiToolContext, PiToolDefinition, PiToolResultSchema } from "./types";

export function definePiTool<TParameters extends TypeBoxSchema, TDetails>(
  tool: PiToolDefinition<TParameters, TDetails>,
): PiToolDefinition<TParameters, TDetails> {
  return tool;
}

export type PiAgentDefinitionInput<
  TToolName extends string = string,
  TSkillName extends string = string,
> = Omit<PiAgentDefinition, "name" | "tools" | "skills"> & {
  tools?: readonly TToolName[];
  skills?: readonly TSkillName[] | "all";
};

export type PiNamedAgentDefinition<
  TName extends string = string,
  TDefinition extends PiAgentDefinitionInput = PiAgentDefinitionInput,
> = TDefinition & { name: TName };

export type PiNamedSkillDefinition<TName extends string = string> = PiSkillDefinition & {
  name: TName;
};

export type PiRuntime<
  TAgents extends PiAgentRegistry = PiAgentRegistry,
  TTools extends PiToolRegistry = PiToolRegistry,
  TSkills extends PiSkillRegistry = PiSkillRegistry,
> = {
  config: Omit<PiFragmentConfig, "agents" | "tools" | "skills"> & {
    agents: TAgents;
    tools: TTools;
    skills: TSkills;
  };
  workflows: WorkflowsRegistry;
};

type ReplaceRegistryEntry<TRegistry, TName extends string, TValue> = Omit<TRegistry, TName> &
  Record<TName, TValue>;

type PiSkillBuilderCallback<TName extends string> = (
  builder: PiSkillDefinitionBuilder<TName>,
) => PiSkillDefinitionBuilder<TName> | PiSkillDefinition | PiSkillDefinitionInput | void;

const materializeSkillDefinition = <TName extends string>(
  name: TName,
  definition: PiSkillDefinition | PiSkillDefinitionInput | PiSkillBuilderCallback<TName>,
): PiNamedSkillDefinition<TName> => {
  const builder = new PiSkillDefinitionBuilder(name);
  const result = typeof definition === "function" ? (definition(builder) ?? builder) : definition;
  const skill = result instanceof PiSkillDefinitionBuilder ? result.build() : { ...result, name };

  if (!skill.description) {
    throw new Error(`Skill '${name}' must define a description.`);
  }

  return { ...skill, name };
};

export class PiBuilder<
  TAgents extends PiAgentRegistry = {},
  TTools extends PiToolRegistry = {},
  TSkills extends PiSkillRegistry = {},
> {
  readonly #agents: PiAgentRegistry = {};
  readonly #tools: PiToolRegistry = {};
  readonly #skills: PiSkillRegistry = {};
  readonly #workflows: Record<string, PiWorkflowDefinition> = {};
  #logging: PiFragmentConfig["logging"];

  withAgent<
    TName extends string,
    const TDefinition extends PiAgentDefinitionInput<
      Extract<keyof TTools, string>,
      Extract<keyof TSkills, string>
    >,
  >(
    name: TName,
    definition: TDefinition,
  ): PiBuilder<
    ReplaceRegistryEntry<TAgents, TName, PiNamedAgentDefinition<TName, TDefinition>>,
    TTools,
    TSkills
  > {
    this.#agents[name] = { ...definition, name };
    return this as unknown as PiBuilder<
      ReplaceRegistryEntry<TAgents, TName, PiNamedAgentDefinition<TName, TDefinition>>,
      TTools,
      TSkills
    >;
  }

  withTool<TName extends string, TTool extends PiTool>(
    name: TName,
    tool: TTool,
  ): PiBuilder<TAgents, ReplaceRegistryEntry<TTools, TName, TTool>, TSkills> {
    this.#tools[name] = tool;
    return this as unknown as PiBuilder<
      TAgents,
      ReplaceRegistryEntry<TTools, TName, TTool>,
      TSkills
    >;
  }

  withSkill<TName extends string>(
    name: TName,
    definition: PiSkillDefinition | PiSkillDefinitionInput | PiSkillBuilderCallback<TName>,
  ): PiBuilder<
    TAgents,
    TTools,
    ReplaceRegistryEntry<TSkills, TName, PiNamedSkillDefinition<TName>>
  > {
    this.#skills[name] = materializeSkillDefinition(name, definition);
    return this as unknown as PiBuilder<
      TAgents,
      TTools,
      ReplaceRegistryEntry<TSkills, TName, PiNamedSkillDefinition<TName>>
    >;
  }

  withWorkflow<
    TName extends string,
    TParams,
    TOutput,
    TInputSchema extends StandardSchemaV1 | undefined,
    TOutputSchema extends StandardSchemaV1 | undefined,
  >(definition: PiWorkflowDefinition<TName, TParams, TOutput, TInputSchema, TOutputSchema>): this {
    this.#workflows[definition.name] = definition as unknown as PiWorkflowDefinition;
    return this;
  }

  logging(config: PiFragmentConfig["logging"]): this {
    this.#logging = config;
    return this;
  }

  build(): PiRuntime<TAgents, TTools, TSkills> {
    const agents = { ...this.#agents } as TAgents;
    const tools = { ...this.#tools } as TTools;
    const skills = { ...this.#skills } as TSkills;
    const workflows = Object.values(this.#workflows);
    const config = {
      agents,
      tools,
      skills,
      workflows,
      logging: this.#logging,
    };

    return {
      config,
      workflows: createPiWorkflows({
        agents,
        tools,
        skills,
        logging: this.#logging,
        workflows,
      }),
    };
  }
}

export const createPi = (): PiBuilder => new PiBuilder();
