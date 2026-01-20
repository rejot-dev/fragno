export type AiToolPolicyContext = {
  threadId: string;
  runId: string;
  runType: "agent" | "deep_research";
  executionMode: "foreground_stream" | "background";
  modelId: string;
  openaiToolConfig: unknown | null;
};

export type AiToolPolicyDecision =
  | { action: "allow"; openaiToolConfig?: unknown | null }
  | { action: "deny"; reason?: string };

export type AiToolPolicy = (
  context: AiToolPolicyContext,
) => AiToolPolicyDecision | Promise<AiToolPolicyDecision>;

export const TOOL_POLICY_DENIED = "TOOL_POLICY_DENIED";
export const TOOL_POLICY_ERROR = "TOOL_POLICY_ERROR";

export const applyToolPolicy = async ({
  policy,
  context,
}: {
  policy?: AiToolPolicy;
  context: AiToolPolicyContext;
}) => {
  if (!policy) {
    return { openaiToolConfig: context.openaiToolConfig, deniedReason: null };
  }

  try {
    const decision = await policy(context);

    if (!decision || typeof decision !== "object") {
      return { openaiToolConfig: context.openaiToolConfig, deniedReason: null };
    }

    if (decision.action === "deny") {
      return {
        openaiToolConfig: null,
        deniedReason: decision.reason ?? TOOL_POLICY_DENIED,
      };
    }

    if (decision.action === "allow") {
      const openaiToolConfig =
        "openaiToolConfig" in decision ? decision.openaiToolConfig : context.openaiToolConfig;
      return { openaiToolConfig: openaiToolConfig ?? null, deniedReason: null };
    }
  } catch {
    return { openaiToolConfig: null, deniedReason: TOOL_POLICY_ERROR };
  }

  return { openaiToolConfig: context.openaiToolConfig, deniedReason: null };
};
