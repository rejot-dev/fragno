import type {
  RemoteWorkflowStepScope,
  RemoteWorkflowSuspension,
} from "@fragno-dev/workflows/remote-workflow";
import { RpcTarget } from "cloudflare:workers";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { returnRemoteWorkflowSuspensionOrThrow } from "./workflow-rpc";

export type CodemodeWorkflowAgentToolDefinition = {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type CodemodeWorkflowAgentToolResult = {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
};

export type CodemodeWorkflowAgentToolExecutor = {
  execute(toolId: string, toolCallId: string, input: unknown): Promise<unknown>;
};

export type CodemodeWorkflowAgentPromptInput = {
  text: string;
  images?: Array<{
    type: "image";
    data: string;
    mimeType: string;
  }>;
  tools?: CodemodeWorkflowAgentToolDefinition[];
};

export type CodemodeWorkflowAgentPromptResult = {
  text: string;
  stopReason: AssistantMessage["stopReason"];
  leafId: string | null;
  toolResults: CodemodeWorkflowAgentToolResult[];
};

export type CodemodeWorkflowAgent = {
  /** Prompts sharing one durable agent session must be awaited sequentially. */
  prompt(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    input: CodemodeWorkflowAgentPromptInput,
    toolExecutor: CodemodeWorkflowAgentToolExecutor | null,
    signal: AbortSignal,
  ): Promise<CodemodeWorkflowAgentPromptResult>;
};

export class CodemodeWorkflowAgentTarget extends RpcTarget {
  readonly #agent: CodemodeWorkflowAgent;
  readonly #abort = new AbortController();

  constructor(agent: CodemodeWorkflowAgent) {
    super();
    this.#agent = agent;
  }

  close(): void {
    this.#abort.abort(new Error("CODEMODE_AGENT_INTERRUPTED"));
  }

  async prompt(
    parentScope: RemoteWorkflowStepScope,
    name: string,
    input: CodemodeWorkflowAgentPromptInput,
    toolExecutor: CodemodeWorkflowAgentToolExecutor | null,
  ): Promise<CodemodeWorkflowAgentPromptResult | RemoteWorkflowSuspension> {
    try {
      this.#abort.signal.throwIfAborted();
      return await this.#agent.prompt(parentScope, name, input, toolExecutor, this.#abort.signal);
    } catch (error) {
      return returnRemoteWorkflowSuspensionOrThrow(error);
    }
  }
}
