declare module "@mariozechner/pi-agent-core" {
  export type AgentToolResult<TDetails = unknown> = {
    content: Array<{ type: "text"; text: string } | { type: "image"; url?: string }>;
    details: TDetails;
  };

  export type AgentToolUpdateCallback<TDetails = unknown> = (
    partialResult: AgentToolResult<TDetails>,
  ) => void;

  export interface AgentTool<TParameters = Record<string, unknown>, TDetails = unknown> {
    name: string;
    parameters?: unknown;
    execute: (
      toolCallId: string,
      params: TParameters,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails>,
    ) => Promise<AgentToolResult<TDetails>>;
  }
}
