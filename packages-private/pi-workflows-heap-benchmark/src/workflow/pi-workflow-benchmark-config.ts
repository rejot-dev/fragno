export const piWorkflowDefaultModels = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5.6-luna",
  google: "gemini-3.1-pro-preview",
} as const;

export type PiWorkflowLiveProvider = keyof typeof piWorkflowDefaultModels;

export type PiWorkflowBenchmarkConfig = {
  mode: "poll" | "stream";
  profile: boolean;
  agent:
    | { kind: "recorded"; replaySpeed: number }
    | { kind: "capture"; provider: PiWorkflowLiveProvider; modelId: string };
};

const DEFAULT_REPLAY_SPEED = 4;
const providerPreference = [
  "openai",
  "anthropic",
  "google",
] as const satisfies readonly PiWorkflowLiveProvider[];
const providerApiKeys = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
} as const satisfies Record<PiWorkflowLiveProvider, string>;

/** Parse Pi workflow benchmark arguments without making provider calls. */
export function parsePiWorkflowBenchmarkArguments(
  args: string[],
  environment: NodeJS.ProcessEnv,
): PiWorkflowBenchmarkConfig {
  let provider: PiWorkflowLiveProvider | undefined;
  let modelId: string | undefined;
  let replaySpeed = DEFAULT_REPLAY_SPEED;
  let replaySpeedProvided = false;
  let capture = false;
  let mode: PiWorkflowBenchmarkConfig["mode"] = "poll";
  let profile = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--stream") {
      mode = "stream";
      continue;
    }
    if (argument === "--profile") {
      profile = true;
      continue;
    }
    if (argument === "--capture") {
      capture = true;
      continue;
    }
    if (argument !== "--provider" && argument !== "--model" && argument !== "--replay-speed") {
      throw new Error(`Unknown Pi workflow benchmark argument: ${argument}`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    if (argument === "--provider") {
      if (value !== "anthropic" && value !== "openai" && value !== "google") {
        throw new Error("--provider must be anthropic, openai, or google.");
      }
      provider = value;
    } else if (argument === "--model") {
      modelId = value;
    } else {
      replaySpeed = Number(value);
      replaySpeedProvided = true;
      if (!Number.isFinite(replaySpeed) || replaySpeed <= 0) {
        throw new Error("--replay-speed must be greater than zero.");
      }
    }
  }

  if (!capture) {
    if (provider || modelId) {
      throw new Error("--provider and --model require --capture.");
    }
    return { mode, profile, agent: { kind: "recorded", replaySpeed } };
  }
  if (replaySpeedProvided) {
    throw new Error("--replay-speed cannot be used with --capture.");
  }

  provider ??= providerPreference.find((candidate) => environment[providerApiKeys[candidate]]);
  if (!provider) {
    throw new Error(
      "No API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env.",
    );
  }
  if (!environment[providerApiKeys[provider]]) {
    throw new Error(`${providerApiKeys[provider]} is required for --provider ${provider}.`);
  }
  return {
    mode,
    profile,
    agent: { kind: "capture", provider, modelId: modelId ?? piWorkflowDefaultModels[provider] },
  };
}
