import { ChatComposerModelMenu } from "@fragno-private/design-system/chat-composer";

import { piAgentModelRef, piBuiltInAgentDefaultModel } from "@/fragno/pi/agent/agent-definitions";
import {
  piAgentModelChoiceSchema,
  type PiAgentModelChoice,
  type PiAvailableModel,
  type PiThinkingLevel,
} from "@/fragno/pi/agent/pi-agent-contract";

const THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A choice among the available models, which the menu shows by label. */
export type AgentModelChoice = { model: PiAvailableModel; thinkingLevel: PiThinkingLevel };

/** The available model a choice names, or null when it is not available. */
export function availableAgentModelChoice(
  choice: PiAgentModelChoice,
  availableModels: readonly PiAvailableModel[],
): AgentModelChoice | null {
  const model = availableModels.find(
    (available) => piAgentModelRef(available) === piAgentModelRef(choice),
  );
  return model ? { model, thinkingLevel: choice.thinkingLevel } : null;
}

export function defaultAgentModelChoice(
  availableModels: readonly PiAvailableModel[],
): AgentModelChoice | null {
  const choice = piBuiltInAgentDefaultModel(availableModels);
  return choice ? availableAgentModelChoice(choice, availableModels) : null;
}

/** How a message's form carries the model its turn runs with. */
export function agentModelChoiceFormFields(choice: AgentModelChoice) {
  return {
    modelProvider: choice.model.provider,
    modelId: choice.model.modelId,
    thinkingLevel: choice.thinkingLevel,
  };
}

/** The model a message's form chose; null keeps the conversation's. */
export function agentModelChoiceFromFormData(formData: FormData): PiAgentModelChoice | null {
  if (!formData.has("modelId")) {
    return null;
  }
  const parsed = piAgentModelChoiceSchema.safeParse({
    provider: formData.get("modelProvider"),
    modelId: formData.get("modelId"),
    thinkingLevel: formData.get("thinkingLevel"),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Chooses the model and reasoning effort a built-in agent's next messages run with. A model that
 * does not support the current effort switches to medium, or else its lowest effort.
 */
export function AgentModelMenu({
  choice,
  availableModels,
  onChoose,
}: {
  choice: AgentModelChoice;
  availableModels: readonly PiAvailableModel[];
  onChoose: (choice: AgentModelChoice) => void;
}) {
  return (
    <ChatComposerModelMenu
      disabled={false}
      model={piAgentModelRef(choice.model)}
      models={availableModels.map((model) => ({
        value: piAgentModelRef(model),
        label: model.label,
      }))}
      onModelChange={(ref) => {
        const model = availableModels.find((available) => piAgentModelRef(available) === ref);
        if (!model) {
          return;
        }
        const thinkingLevel = model.thinkingLevels.includes(choice.thinkingLevel)
          ? choice.thinkingLevel
          : model.thinkingLevels.includes("medium")
            ? "medium"
            : model.thinkingLevels[0];
        onChoose({ model, thinkingLevel });
      }}
      effort={choice.thinkingLevel}
      efforts={choice.model.thinkingLevels.map((level) => ({
        value: level,
        label: THINKING_LEVEL_LABELS[level],
      }))}
      onEffortChange={(thinkingLevel) => {
        onChoose({ model: choice.model, thinkingLevel });
      }}
    />
  );
}
