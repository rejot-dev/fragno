import type { WorkflowAgentHarnessOptions } from "@fragno-dev/pi-harness/workflows/workflow-agent-harness";

import {
  formatSkillsForSystemPrompt,
  type AgentTool,
  type Skill,
} from "@earendil-works/pi-agent-core";
import type { AuthContext, Models } from "@earendil-works/pi-ai";

import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { renderCodemodeSystemPrompt } from "@/fragno/codemode/codemode-dts";

import {
  PI_PROVIDER_TO_MODEL_PROVIDER,
  PI_SUPPORTED_MODELS,
  PI_SYSTEM_PROMPT,
  PI_THINKING_LEVEL,
  type PiApiKeys,
  type PiModel,
} from "./pi-shared";
import { loadBackofficePiSkills } from "./pi-skills";
import { resolvePiStateBackend, type PiRuntimeToolContextSource } from "./pi-tools";

export const resolveBackofficeModel = (
  models: Models,
  provider: keyof typeof PI_PROVIDER_TO_MODEL_PROVIDER,
  modelName: string,
) =>
  models
    .getModels(PI_PROVIDER_TO_MODEL_PROVIDER[provider])
    .find((model) => model.name === modelName || model.id === modelName);

export const createBackofficeAuthContext = (apiKeys: PiApiKeys): AuthContext => ({
  env: async (name) => {
    switch (name) {
      case "OPENAI_API_KEY":
        return apiKeys.openai;
      case "ANTHROPIC_API_KEY":
        return apiKeys.anthropic;
      case "GEMINI_API_KEY":
        return apiKeys.gemini;
      default:
        return undefined;
    }
  },
  fileExists: async () => false,
});

export type BackofficePiSkillResolver = (input: {
  sessionId: string;
  execution: BackofficeExecutionContext;
}) => Promise<Skill[]>;

export const createBackofficePiSkillResolver =
  (runtimeToolContext: PiRuntimeToolContextSource): BackofficePiSkillResolver =>
  async ({ execution }) => {
    const skills = await loadBackofficePiSkills(
      resolvePiStateBackend(runtimeToolContext, execution),
    );
    return Object.values(skills).map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.body ?? "",
      filePath: skill.location ?? `${skill.directory ?? "/skills"}/${skill.name}/SKILL.md`,
    }));
  };

export type BackofficeSystemPromptResolver = (options: {
  sessionId: string;
  execution: BackofficeExecutionContext;
  baseSystemPrompt: string;
}) => Promise<string>;

export const createBackofficeSystemPromptResolver =
  (runtimeToolContext: PiRuntimeToolContextSource): BackofficeSystemPromptResolver =>
  async ({ execution, baseSystemPrompt }) => {
    const state = resolvePiStateBackend(runtimeToolContext, execution);
    return `${baseSystemPrompt}\n\n${await renderCodemodeSystemPrompt({ state })}`;
  };

const buildSystemPrompt = async (options: {
  systemPrompt?: string;
  skills: Skill[];
  resolveSystemPrompt: BackofficeSystemPromptResolver;
  sessionId: string;
  execution: BackofficeExecutionContext;
}) => {
  const baseSystemPrompt = [
    options.systemPrompt ?? PI_SYSTEM_PROMPT,
    formatSkillsForSystemPrompt(options.skills),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return await options.resolveSystemPrompt({
    sessionId: options.sessionId,
    execution: options.execution,
    baseSystemPrompt,
  });
};

export const resolveDefaultBackofficePiModel = async (models: Models): Promise<PiModel | null> => {
  for (const option of PI_SUPPORTED_MODELS) {
    const resolvedModel = resolveBackofficeModel(models, option.provider, option.name);
    if (resolvedModel && (await models.checkAuth(resolvedModel.provider))) {
      return { provider: option.provider, name: option.name };
    }
  }
  return null;
};

export const validateBackofficePiModel = (models: Models, selection: PiModel): string | null => {
  const model = resolveBackofficeModel(models, selection.provider, selection.name);
  return model ? null : `Model ${selection.provider}/${selection.name} not found.`;
};

export const resolveBackofficeWorkflowAgentHarnessOptions = async ({
  models,
  tools,
  skills,
  resolveSystemPrompt,
  sessionId,
  execution,
  selectedModel,
  systemPrompt,
  thinkingLevel,
}: {
  models: Models;
  tools: AgentTool[];
  skills: BackofficePiSkillResolver;
  resolveSystemPrompt: BackofficeSystemPromptResolver;
  sessionId: string;
  execution: BackofficeExecutionContext;
  selectedModel: PiModel;
  systemPrompt?: string;
  thinkingLevel?: import("@earendil-works/pi-agent-core").ThinkingLevel;
}): Promise<WorkflowAgentHarnessOptions> => {
  const model = resolveBackofficeModel(models, selectedModel.provider, selectedModel.name);
  if (!model) {
    throw new Error(`Model ${selectedModel.provider}/${selectedModel.name} not found.`);
  }

  if (!(await models.checkAuth(model.provider))) {
    throw new Error(`API key for provider ${model.provider} is not configured.`);
  }

  const agentSkills = await skills({ sessionId, execution });

  return {
    model,
    models,
    thinkingLevel: thinkingLevel ?? PI_THINKING_LEVEL,
    systemPrompt: await buildSystemPrompt({
      systemPrompt,
      skills: agentSkills,
      resolveSystemPrompt,
      sessionId,
      execution,
    }),
    resources: { skills: agentSkills },
    tools,
  };
};
