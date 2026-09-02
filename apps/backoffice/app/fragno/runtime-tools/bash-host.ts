import { Bash as BashRuntime, defineCommand, type Bash } from "just-bash";

import type {
  BackofficeContextScope,
  BackofficeExecutionContext,
} from "@/backoffice-runtime/context";
import type { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  createBackofficeBashCommands,
  getAvailableRuntimeTools,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import { createBackofficeToolContext } from "@/fragno/runtime-tools/tool-context";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { AutomationCommandContext, BashAutomationCommandResult } from "./automation-types";
import { createCurrentScopeBashCommand } from "./current-scope-command";
import type { AdminRuntime } from "./families/admin";
import type { RegisteredApiCommandContext } from "./families/api-runtime";
import type { AutomationStoreRuntime } from "./families/automations-bindings";
import type { DurableHooksRuntime } from "./families/automations-durable-hooks";
import type { AutomationIdentityRuntime } from "./families/automations-identities";
import type { AutomationRouterRuntime } from "./families/automations-routing";
import type { AutomationWorkflowRuntime } from "./families/automations-workflow";
import type { BackofficeCapabilitiesRuntime } from "./families/backoffice-capabilities";
import type { CloudflareRuntime } from "./families/cloudflare-runtime";
import type { EventRuntime } from "./families/event-runtime";
import type { FormsRuntime } from "./families/forms-runtime";
import type { GitHubRuntime } from "./families/github-runtime";
import type { InternalRuntime } from "./families/internal";
import type { RegisteredMcpCommandContext } from "./families/mcp-runtime";
import type { RegisteredOtpCommandContext } from "./families/otp-runtime";
import type { RegisteredPiCommandContext } from "./families/pi-runtime";
import type { RegisteredResendCommandContext } from "./families/resend-runtime";
import type { RegisteredReson8CommandContext } from "./families/reson8-runtime";
import type { SandboxRuntime } from "./families/sandbox-runtime";
import type { RegisteredTelegramCommandContext } from "./families/telegram-runtime";
import type { UploadRuntime } from "./families/upload-runtime";
import type { WebRuntime } from "./families/web-runtime";
import { isomorphicGitCommands } from "./isomorphic-git-command";

export type RegisteredAutomationsRuntime = AutomationStoreRuntime & AutomationRouterRuntime;

export type RegisteredAutomationsBashCommandContext = {
  runtime: RegisteredAutomationsRuntime;
};

export type RegisteredEventBashCommandContext = AutomationCommandContext & {
  runtime: EventRuntime;
};

export type BashHostContext = {
  execution: BackofficeExecutionContext;
  backofficeKernel: BackofficeKernel;
  stateBackend?: BackofficeStateBackend;
  createBackofficeScopedContext(scope: BackofficeContextScope): BashHostContext;
  admin?: { runtime: AdminRuntime } | null;
  backoffice: { runtime: BackofficeCapabilitiesRuntime } | null;
  automation: RegisteredEventBashCommandContext | null;
  cloudflare?: { runtime: CloudflareRuntime } | null;
  event?: { runtime: EventRuntime } | null;
  forms?: { runtime: FormsRuntime } | null;
  github?: { runtime: GitHubRuntime } | null;
  automations: RegisteredAutomationsBashCommandContext | null;
  identity?: { runtime: AutomationIdentityRuntime } | null;
  workflow?: { runtime: AutomationWorkflowRuntime } | null;
  durableHooks?: { runtime: DurableHooksRuntime } | null;
  internal?: { runtime: InternalRuntime } | null;
  api?: RegisteredApiCommandContext | null;
  mcp?: RegisteredMcpCommandContext | null;
  otp: RegisteredOtpCommandContext | null;
  pi: RegisteredPiCommandContext | null;
  reson8: RegisteredReson8CommandContext | null;
  resend: RegisteredResendCommandContext | null;
  sandbox?: { runtime: SandboxRuntime } | null;
  telegram: RegisteredTelegramCommandContext | null;
  upload?: { runtime: UploadRuntime } | null;
  web?: { runtime: WebRuntime } | null;
};

export type InteractiveRuntimeToolContext = Omit<BashHostContext, "automation"> & {
  automation: null;
  automations: NonNullable<BashHostContext["automations"]>;
  workflow?: BashHostContext["workflow"];
  durableHooks?: BashHostContext["durableHooks"];
  forms?: BashHostContext["forms"];
  api?: BashHostContext["api"];
  mcp?: BashHostContext["mcp"];
  otp: NonNullable<BashHostContext["otp"]>;
  pi: NonNullable<BashHostContext["pi"]>;
  reson8: NonNullable<BashHostContext["reson8"]>;
  resend: NonNullable<BashHostContext["resend"]>;
  sandbox?: BashHostContext["sandbox"];
  telegram: NonNullable<BashHostContext["telegram"]>;
};

type BashOptions = NonNullable<ConstructorParameters<typeof BashRuntime>[0]>;

type CreateBashHostInput = {
  fs: BashOptions["fs"];
  env?: BashOptions["env"];
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult?: BashAutomationCommandResult[];
};

export type BashHost = {
  bash: Bash;
  sessionId?: string;
  context: BashHostContext;
  commandCallsResult: BashAutomationCommandResult[];
};

type BashCommandFactoryInput = {
  sessionId?: string;
  commandCallsResult: BashAutomationCommandResult[];
  context: BashHostContext;
};

type BashCommandAvailability = "available-only" | "describe-unavailable";

function describeBackofficeScope(context: BackofficeToolContext): string {
  switch (context.execution.scope.kind) {
    case "system":
      return "System";
    case "org":
      return "organization";
    case "project":
      return "project";
    case "user":
      return "user";
  }

  throw new Error("Unsupported Backoffice scope kind.");
}

function unavailableRuntimeToolCommandMessage({
  command,
  namespace,
  context,
}: {
  command: string;
  namespace: string;
  context: BackofficeToolContext;
}): string {
  const scope = describeBackofficeScope(context);
  if (namespace === "admin" && context.execution.scope.kind !== "system") {
    return [
      `Backoffice command unavailable: '${command}' is not supported in the current ${scope} scope.`,
      "Admin commands require the System scope. Select System in the Backoffice scope switcher and retry.",
      "Run 'context.current --format json' to inspect the current scope.",
    ].join("\n");
  }

  return [
    `Backoffice command unavailable: '${command}' is not supported in the current ${scope} runtime context.`,
    "The selected scope or Backoffice environment does not provide this command's runtime.",
    "Run 'context.current --format json' to inspect the current scope, then switch scopes and retry.",
  ].join("\n");
}

function createUnavailableRuntimeToolBashCommands({
  context,
  commandCallsResult,
}: {
  context: BackofficeToolContext;
  commandCallsResult: BashAutomationCommandResult[];
}) {
  return runtimeToolFamilies.flatMap((family) => {
    if (!family.isAvailable || family.isAvailable(context)) {
      return [];
    }

    return family.tools.flatMap((tool) => {
      const command = tool.adapters?.bash?.command;
      if (!command) {
        return [];
      }

      return [
        defineCommand(command, async () => {
          commandCallsResult.push({ command, output: "", exitCode: 1 });
          return {
            stdout: "",
            stderr: `${unavailableRuntimeToolCommandMessage({
              command,
              namespace: tool.namespace,
              context,
            })}\n`,
            exitCode: 1,
          };
        }),
      ];
    });
  });
}

function createRegisteredBashCommands(
  input: BashCommandFactoryInput,
  commandAvailability: BashCommandAvailability,
) {
  const context = createBackofficeToolContext(input.context);
  const tools = getAvailableRuntimeTools({
    families: runtimeToolFamilies,
    context,
  });

  return [
    ...createBackofficeBashCommands({
      tools,
      context,
      commandCallsResult: input.commandCallsResult,
    }),
    ...(commandAvailability === "describe-unavailable"
      ? createUnavailableRuntimeToolBashCommands({
          context,
          commandCallsResult: input.commandCallsResult,
        })
      : []),
    createCurrentScopeBashCommand(input.context.execution.scope, defineCommand),
    ...isomorphicGitCommands,
  ];
}

function createConfiguredBashHost(
  input: CreateBashHostInput,
  commandAvailability: BashCommandAvailability,
): BashHost {
  const commandCallsResult = input.commandCallsResult ?? [];
  const commandInput: BashCommandFactoryInput = {
    sessionId: input.sessionId,
    commandCallsResult,
    context: input.context,
  };

  return {
    bash: new BashRuntime({
      fs: input.fs,
      env: input.env,
      defenseInDepth: false,
      customCommands: createRegisteredBashCommands(commandInput, commandAvailability),
    }),
    sessionId: input.sessionId,
    context: input.context,
    commandCallsResult,
  };
}

export function createBashHost(input: CreateBashHostInput): BashHost {
  return createConfiguredBashHost(input, "available-only");
}

/** Creates an interactive shell that explains why known commands are unavailable. */
export function createInteractiveRuntimeBashHost(input: CreateBashHostInput): BashHost {
  return createConfiguredBashHost(input, "describe-unavailable");
}
