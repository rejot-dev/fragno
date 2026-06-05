import { RpcTarget } from "cloudflare:workers";

import type { MasterFileSystem } from "@/files/master-file-system";
import type { AutomationEvent } from "@/fragno/automation/contracts";
import { AUTOMATION_SCRIPT_ENGINES } from "@/fragno/automation/engines";
import { createRouteBackedAutomationsRuntime } from "@/fragno/automation/identity-runtime";
import { runBackofficeCodemode, type BackofficeCodemodeEnv } from "@/fragno/codemode/execute";
import type { AutomationExecutionContext } from "@/fragno/runtime-tools/automation-host";
import type { AutomationsRuntime } from "@/fragno/runtime-tools/families/automations";
import type { EventRuntime } from "@/fragno/runtime-tools/families/event";
import { createEventRuntime } from "@/fragno/runtime-tools/families/event-runtime";
import type { OtpRuntime } from "@/fragno/runtime-tools/families/otp";
import { createOtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import type { PiRuntime } from "@/fragno/runtime-tools/families/pi";
import { createPiRouteRuntime } from "@/fragno/runtime-tools/families/pi-runtime";
import type { ResendRuntime } from "@/fragno/runtime-tools/families/resend";
import { createResendRouteRuntime } from "@/fragno/runtime-tools/families/resend-runtime";
import type { Reson8Runtime } from "@/fragno/runtime-tools/families/reson8";
import { createReson8RouteRuntime } from "@/fragno/runtime-tools/families/reson8-runtime";
import type { TelegramRuntime } from "@/fragno/runtime-tools/families/telegram";
import { createTelegramRuntime } from "@/fragno/runtime-tools/families/telegram-runtime";
import {
  executeBackofficeRuntimeTool,
  getAvailableRuntimeTools,
  summarizeToolValue,
  type AnyBackofficeRuntimeTool,
  type BackofficeToolContext,
} from "@/fragno/runtime-tools/runtime-tools";
import { automationRuntimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { CodemodeWorkflowInstanceCreator } from "../codemode-workflow-facet";
import { createAutomationRunResult, type AutomationRunResult } from "../run-result";
import { createAutomationExecutionFileSystem } from "./execution-file-system";

type AutomationCodemodeToolContext = BackofficeToolContext<{
  automations?: AutomationsRuntime;
  event?: EventRuntime;
  otp?: OtpRuntime;
  pi?: PiRuntime;
  resend?: ResendRuntime;
  reson8?: Reson8Runtime;
  telegram?: TelegramRuntime;
}>;

export const createAutomationToolRuntimeContext = (
  context: AutomationExecutionContext,
): AutomationCodemodeToolContext => ({
  runtimes: {
    automations: context.automations?.runtime,
    event: context.automation.runtime,
    otp: context.otp?.runtime,
    pi: context.pi?.runtime,
    resend: context.resend?.runtime,
    reson8: context.reson8?.runtime,
    telegram: context.telegram?.runtime,
  },
});

export const getAutomationCodemodeTools = (context: AutomationExecutionContext) => {
  return getAvailableRuntimeTools({
    families: automationRuntimeToolFamilies,
    context: createAutomationToolRuntimeContext(context),
  });
};

const isJavaScriptIdentifier = (value: string) => /^[A-Za-z_$][\w$]*$/.test(value);

export const renderCodemodeWorkflowToolGlobals = (tools: readonly AnyBackofficeRuntimeTool[]) => {
  const namespaces = new Map<string, string[]>();
  for (const tool of tools) {
    namespaces.set(tool.namespace, [...(namespaces.get(tool.namespace) ?? []), tool.name]);
  }

  return [...namespaces]
    .map(([namespace, names]) => {
      const entries = names
        .map(
          (name) =>
            `${JSON.stringify(name)}: (input) => callTool(${JSON.stringify(namespace)}, ${JSON.stringify(name)}, input)`,
        )
        .join(",\n  ");
      const objectLiteral = `{\n  ${entries}\n}`;
      return isJavaScriptIdentifier(namespace)
        ? `const ${namespace} = ${objectLiteral};`
        : `globalThis[${JSON.stringify(namespace)}] = ${objectLiteral};`;
    })
    .join("\n\n");
};

type CodemodeWorkflowToolCallPayload = {
  orgId?: string;
  binding: {
    id?: string;
    scriptId: string;
    scriptVersion?: number;
    source?: string;
    eventType?: string;
  };
  event: AutomationEvent;
  input: unknown;
};

const createCodemodeWorkflowExecutionContext = ({
  env,
  payload,
}: {
  env: CloudflareEnv;
  payload: CodemodeWorkflowToolCallPayload;
}): AutomationExecutionContext => {
  const orgId = payload.orgId?.trim() || payload.event.orgId?.trim() || undefined;
  const orgRuntimes = orgId
    ? {
        automations: { runtime: createRouteBackedAutomationsRuntime({ env, orgId }) },
        otp: { runtime: createOtpRuntime({ env, orgId }) },
        pi: { runtime: createPiRouteRuntime({ env, orgId }) },
        reson8: { runtime: createReson8RouteRuntime({ env, orgId }) },
        resend: { runtime: createResendRouteRuntime({ env, orgId }) },
        telegram: { runtime: createTelegramRuntime({ env, orgId }) },
      }
    : {
        automations: null,
        otp: null,
        pi: null,
        reson8: null,
        resend: null,
        telegram: null,
      };

  return {
    automation: {
      event: payload.event,
      orgId,
      binding: {
        source: payload.binding.source ?? payload.event.source,
        eventType: payload.binding.eventType ?? payload.event.eventType,
        ...(payload.binding.id ? { id: payload.binding.id } : {}),
        scriptId: payload.binding.scriptId,
        ...(typeof payload.binding.scriptVersion === "number"
          ? { scriptVersion: payload.binding.scriptVersion }
          : {}),
      },
      idempotencyKey: payload.event.id,
      bashEnv: {},
      runtime: createEventRuntime({ env, event: payload.event }),
    },
    ...orgRuntimes,
  };
};

export class CodemodeWorkflowToolDispatcher extends RpcTarget {
  readonly #env: CloudflareEnv;

  constructor({ env }: { env: CloudflareEnv }) {
    super();
    this.#env = env;
  }

  async call(namespace: string, name: string, payloadJson?: string): Promise<string> {
    const payload = payloadJson
      ? (JSON.parse(payloadJson) as CodemodeWorkflowToolCallPayload)
      : null;
    if (!payload) {
      return JSON.stringify({
        error: `Missing codemode workflow tool payload for ${namespace}.${name}`,
      });
    }

    const context = createCodemodeWorkflowExecutionContext({ env: this.#env, payload });
    const tool = getAutomationCodemodeTools(context).find(
      (candidate) => candidate.namespace === namespace && candidate.name === name,
    );
    if (!tool) {
      return JSON.stringify({ error: `Unknown codemode workflow tool: ${namespace}.${name}` });
    }

    try {
      return JSON.stringify({
        result: await executeBackofficeRuntimeTool(
          tool,
          payload.input,
          createAutomationToolRuntimeContext(context),
        ),
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        tool: `${tool.namespace}.${tool.name}`,
        input: summarizeToolValue(payload.input),
      });
    }
  }
}

export const executeCodemodeWorkflowAutomation = async ({
  script,
  context,
  createCodemodeWorkflowInstance,
}: {
  script: string;
  context: AutomationExecutionContext;
  createCodemodeWorkflowInstance?: CodemodeWorkflowInstanceCreator;
}): Promise<AutomationRunResult<typeof AUTOMATION_SCRIPT_ENGINES.codemodeWorkflow>> => {
  const tools = getAutomationCodemodeTools(context);
  const response = await createCodemodeWorkflowInstance?.({
    event: context.automation.event,
    binding: {
      ...(context.automation.binding.id ? { id: context.automation.binding.id } : {}),
      scriptId: context.automation.binding.scriptId,
      ...(typeof context.automation.binding.scriptVersion === "number"
        ? { scriptVersion: context.automation.binding.scriptVersion }
        : {}),
      scriptBody: script,
    },
    tools,
  });

  if (!response) {
    throw new Error("Codemode automation workflows are not configured.");
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return createAutomationRunResult({
    runtime: AUTOMATION_SCRIPT_ENGINES.codemodeWorkflow,
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: 0,
    result: await response.json().catch(() => undefined),
  });
};

export const executeCodemodeAutomation = async ({
  script,
  context,
  masterFs,
  env,
}: {
  script: string;
  context: AutomationExecutionContext;
  masterFs: MasterFileSystem;
  env: BackofficeCodemodeEnv;
}): Promise<AutomationRunResult<"codemode">> => {
  const executionFs = createAutomationExecutionFileSystem({
    masterFs,
    eventJson: JSON.stringify(context.automation.event),
    envJson: JSON.stringify(context.automation.bashEnv),
  });
  const toolContext = createAutomationToolRuntimeContext(context);
  const tools = getAutomationCodemodeTools(context);
  const result = await runBackofficeCodemode({
    code: script,
    fs: executionFs,
    env,
    tools,
    context: toolContext,
  });

  return createAutomationRunResult({
    runtime: "codemode",
    eventId: context.automation.event.id,
    scriptId: context.automation.binding.scriptId,
    exitCode: result.error ? 1 : 0,
    stderr: result.error ?? "",
    logs: result.logs ?? [],
    result: result.result,
    toolCalls: result.toolCalls,
  });
};
