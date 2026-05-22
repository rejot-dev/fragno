import type { StandardSchemaV1 } from "@fragno-dev/core/api";
import {
  NonRetryableError,
  type WorkflowDefinition,
  type WorkflowDuration,
  type WorkflowEvent,
  type WorkflowsRegistry,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "@fragno-dev/workflows/workflow";
import type { TSchema as TypeBoxSchema } from "typebox";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createPiWorkflows } from "./factory";
import type {
  PiAgentDefinition,
  PiAgentRegistry,
  PiFragmentConfig,
  PiPromptInput,
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

export type PiWorkflowAgentHandle = {
  run(name: string, options: PiWorkflowAgentRunOptions): Promise<PiAgentStepResult>;
  prompt(name: string, options: PiWorkflowAgentPromptOptions): Promise<PiAgentStepResult>;
  continue(name: string, options?: PiWorkflowAgentStepOptions): Promise<PiAgentStepResult>;
};

export type PiWorkflowAgentRunOptions = PiWorkflowAgentStepOptions & {
  mode: "prompt" | "continue";
  input?: PiPromptInput;
};

export type PiWorkflowAgentPromptOptions = PiWorkflowAgentStepOptions & {
  input: PiPromptInput;
};

export type PiWorkflowAgentStepOptions = {
  messages?: AgentMessage[];
  systemPrompt?: string;
  step?: WorkflowStepConfig;
  controls?: Array<"abort" | "steer">;
  stopOnTools?: Array<string | PiToolDefinition>;
  toolExecution?: "sequential" | "parallel";
  turnId?: string;
};

export type PiWorkflowContext<TParams = unknown> = {
  params: TParams;
  sessionId: string;
  event: WorkflowEvent<TParams>;
  step: WorkflowStep;
  agent(name: string): PiWorkflowAgentHandle;
  waitForEvent(
    name: string,
    options?: {
      allowed?: PiSessionCommandPayload["kind"][];
      timeout?: WorkflowDuration;
    },
  ): Promise<PiSessionCommandPayload>;
  sleep(name: string, duration: WorkflowDuration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
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
  run: PiWorkflowRunFn<unknown, unknown>,
): PiWorkflowDefinition<
  TName,
  unknown,
  unknown,
  StandardSchemaV1 | undefined,
  StandardSchemaV1 | undefined
> {
  return { ...options, run };
}

export type CompilePiWorkflowOptions = {
  agents?: PiAgentRegistry;
  tools?: PiToolRegistry;
  agentRunner?: PiAgentRunner;
};

const stopOnToolNames = (tools: Array<string | PiToolDefinition> | undefined) =>
  tools?.map((tool) => (typeof tool === "string" ? tool : tool.name));

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
    return definition.run({
      params: event.payload,
      sessionId: event.instanceId,
      event,
      step,
      agent: (agentName) => {
        const agent = options.agents?.[agentName];
        if (!agent) {
          throw new NonRetryableError(`Agent ${agentName} not found.`);
        }

        const runAgentStep = (name: string, runOptions: PiWorkflowAgentRunOptions) =>
          runPiAgentStep(
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
                systemPrompt: runOptions.systemPrompt,
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
            },
          );

        return {
          run: runAgentStep,
          prompt: (name, promptOptions) => runAgentStep(name, { ...promptOptions, mode: "prompt" }),
          continue: (name, continueOptions = {}) =>
            runAgentStep(name, { ...continueOptions, mode: "continue" }),
        };
      },
      waitForEvent: async (name, options) => {
        for (let ignoredCommands = 0; ; ignoredCommands += 1) {
          const commandEvent = await step.waitForEvent<PiSessionCommandPayload>(
            ignoredCommands === 0 ? name : `${name}-${ignoredCommands}`,
            {
              type: "command",
              timeout: options?.timeout,
            },
          );
          const command = commandEvent.payload;
          if (!options?.allowed || options.allowed.includes(command.kind)) {
            return command;
          }
        }
      },
      sleep: (name, duration) => step.sleep(name, duration),
      sleepUntil: (name, timestamp) => step.sleepUntil(name, timestamp),
    });
  };

  return {
    name: definition.name,
    schema: definition.schema,
    outputSchema: definition.outputSchema,
    run,
  };
};

export type { PiTool, PiToolContext, PiToolDefinition, PiToolResultSchema } from "./types";

export function definePiTool<TParameters extends TypeBoxSchema, TDetails>(
  tool: PiToolDefinition<TParameters, TDetails>,
): PiToolDefinition<TParameters, TDetails> {
  return tool;
}

export type PiAgentDefinitionInput<TToolName extends string = string> = Omit<
  PiAgentDefinition,
  "name" | "tools"
> & {
  tools?: readonly TToolName[];
};

export type PiNamedAgentDefinition<
  TName extends string = string,
  TDefinition extends PiAgentDefinitionInput = PiAgentDefinitionInput,
> = TDefinition & { name: TName };

export type PiRuntime<
  TAgents extends PiAgentRegistry = PiAgentRegistry,
  TTools extends PiToolRegistry = PiToolRegistry,
> = {
  config: Omit<PiFragmentConfig, "agents" | "tools"> & {
    agents: TAgents;
    tools: TTools;
  };
  workflows: WorkflowsRegistry;
};

type ReplaceRegistryEntry<TRegistry, TName extends string, TValue> = Omit<TRegistry, TName> &
  Record<TName, TValue>;

export class PiBuilder<TAgents extends PiAgentRegistry = {}, TTools extends PiToolRegistry = {}> {
  readonly #agents: PiAgentRegistry = {};
  readonly #tools: PiToolRegistry = {};
  readonly #workflows: Record<string, PiWorkflowDefinition> = {};
  #logging: PiFragmentConfig["logging"];

  withAgent<
    TName extends string,
    const TDefinition extends PiAgentDefinitionInput<Extract<keyof TTools, string>>,
  >(
    name: TName,
    definition: TDefinition,
  ): PiBuilder<
    ReplaceRegistryEntry<TAgents, TName, PiNamedAgentDefinition<TName, TDefinition>>,
    TTools
  > {
    this.#agents[name] = { ...definition, name };
    return this as unknown as PiBuilder<
      ReplaceRegistryEntry<TAgents, TName, PiNamedAgentDefinition<TName, TDefinition>>,
      TTools
    >;
  }

  withTool<TName extends string, TTool extends PiTool>(
    name: TName,
    tool: TTool,
  ): PiBuilder<TAgents, ReplaceRegistryEntry<TTools, TName, TTool>> {
    this.#tools[name] = tool;
    return this as unknown as PiBuilder<TAgents, ReplaceRegistryEntry<TTools, TName, TTool>>;
  }

  withWorkflow<
    TName extends string,
    TParams,
    TOutput,
    TInputSchema extends StandardSchemaV1 | undefined,
    TOutputSchema extends StandardSchemaV1 | undefined,
  >(
    definition: PiWorkflowDefinition<TName, TParams, TOutput, TInputSchema, TOutputSchema>,
  ): PiBuilder<TAgents, TTools> {
    this.#workflows[definition.name] = definition as unknown as PiWorkflowDefinition;
    return this;
  }

  logging(config: PiFragmentConfig["logging"]): PiBuilder<TAgents, TTools> {
    this.#logging = config;
    return this;
  }

  build(): PiRuntime<TAgents, TTools> {
    const agents = { ...this.#agents } as TAgents;
    const tools = { ...this.#tools } as TTools;
    const workflows = Object.values(this.#workflows);
    const config = {
      agents,
      tools,
      workflows,
      logging: this.#logging,
    };

    return {
      config,
      workflows: createPiWorkflows({
        agents,
        tools,
        logging: this.#logging,
        workflows,
      }),
    };
  }
}

export const createPi = (): PiBuilder => new PiBuilder();
