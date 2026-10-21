import type { PiAgentConfig } from "@fragno-dev/backoffice-api/v0/pi";
import { BACKOFFICE_PERMISSION } from "@fragno-dev/backoffice-api/v0/shared/permissions";
import type { BackofficeContextScope } from "@fragno-dev/backoffice-api/v0/shared/scope";

import type { Context } from "@earendil-works/chord";

import { withBackofficeActorCapabilityGrants } from "@/backoffice-runtime/authority-resolver";
import type { BackofficeExecutionContext } from "@/backoffice-runtime/context";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { BackofficeRuntimeServices } from "@/backoffice-runtime/runtime-services";
import { appendAutomationDelegate } from "@/fragno/automation/authority";
import { codemodeRunnerFor, type CodemodeRunner } from "@/fragno/codemode/codemode-object-execute";
import type { BackofficeStateBackend } from "@/fragno/codemode/state-backend";
import {
  createPiManagerRuntime,
  type PiManagerRuntime,
} from "@/fragno/pi/manager/pi-manager-runtime";
import type {
  InteractiveRuntimeToolContext,
  RegisteredAutomationsRuntime,
} from "@/fragno/runtime-tools/bash-host";
import type { OtpRuntime } from "@/fragno/runtime-tools/families/otp-runtime";
import { createRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { piAgentActor } from "./pi-agent-actor";
import type { PiAgentTurn } from "./pi-agent-contract";

/** Runtime services available to Backoffice tools executed by a durable Pi agent. */
export type PiRuntimeToolContext = InteractiveRuntimeToolContext & {
  automations: { runtime: RegisteredAutomationsRuntime };
  otp: { runtime: OtpRuntime };
  pi: { runtime: PiManagerRuntime };
};

/** Backoffice authority and services of the turn that owns an agent's current work. */
export type BackofficeAgentTurnContext = {
  /** The submitter's actors with the agent appended as an assistant delegate. */
  execution: BackofficeExecutionContext;
  /** The agent definition's instructions, as read when the turn was admitted. */
  instructions: string;
  /** Null when the runtime has no Worker Loader; codemode-backed extensions fail closed. */
  codemode: CodemodeRunner | null;
  /** Checks live permissions; persisted actors carry identity, not grants. */
  authorize: () => Promise<void>;
  toolContext: (invocationId: string, context: Context) => PiRuntimeToolContext;
};

/** One agent's Backoffice identity; every capability comes from the turn that owns its work. */
export type BackofficeAgentContext = {
  agentName: string;
  scope: BackofficeContextScope;
  /** Throws when no turn owns the current work, so nothing runs without an authority. */
  activeTurn: (context: Context) => Promise<BackofficeAgentTurnContext>;
  /** For work done on a turn's behalf before Pi admits it, such as loading its extensions. */
  turn: (turn: PiAgentTurn) => BackofficeAgentTurnContext;
};

/** Returns the scoped filesystem used by durable Pi tools and prompt sections. */
export function requirePiStateBackend(context: PiRuntimeToolContext): BackofficeStateBackend {
  if (!context.stateBackend) {
    throw new Error("Pi requires a state backend.");
  }
  return context.stateBackend;
}

/** Rebuilds the scoped Backoffice context of whichever turn currently owns the agent's work. */
export function createBackofficeAgentContext(input: {
  config: PiAgentConfig;
  runtime: BackofficeRuntimeServices;
  readActiveTurn: (context: Context) => Promise<PiAgentTurn | null>;
}): BackofficeAgentContext {
  const { config } = input;
  const agentActor = piAgentActor(config.scope, config.agentName);

  function createTurnContext(turn: PiAgentTurn): BackofficeAgentTurnContext {
    // Grants bind to this turn only; elsewhere the pi-agent actor does not narrow, like other
    // runtime capability delegates.
    const runtime: BackofficeRuntimeServices = {
      ...input.runtime,
      authorityResolver: withBackofficeActorCapabilityGrants({
        resolver: input.runtime.authorityResolver,
        actor: agentActor,
        grants: turn.agent.permissions,
      }),
    };
    const kernel = new BackofficeKernel(runtime);
    const submitterExecution: BackofficeExecutionContext = {
      kind: "deferred",
      scope: config.scope,
      scopeRestriction: turn.scopeRestriction,
      actors: turn.actors,
    };
    const execution = appendAutomationDelegate({
      execution: submitterExecution,
      delegate: agentActor,
    });

    // Running a turn is the submitter's act; the definition narrows only what the turn does.
    async function authorize() {
      await kernel.assertAuthorized({
        execution: submitterExecution,
        operation: BACKOFFICE_PERMISSION.pi.modify,
        resource: { kind: "pi-agent-turn", agentName: config.agentName },
      });
    }

    function toolContext(invocationId: string, context: Context): PiRuntimeToolContext {
      let promptIndex = 0;
      const createPromptRequestId = () => `${invocationId}:${promptIndex++}`;
      return createRouteBackedRuntimeContext({
        emitter: { kind: "caller" },
        runtime,
        kernel,
        execution,
        // A factory follows scope changes; a fixed runtime would leak the parent directory into child contexts.
        pi: (scopedExecution) => ({
          runtime: createPiManagerRuntime({
            runtime,
            kernel,
            execution: scopedExecution,
            createPromptRequestId,
            context,
          }),
        }),
      }) as PiRuntimeToolContext;
    }

    return {
      execution,
      instructions: turn.agent.instructions,
      codemode: runtime.codemodeEnv
        ? codemodeRunnerFor(
            kernel.scoped("CODEMODE", config.scope, runtime.objects.codemode).commands,
            execution,
          )
        : null,
      authorize,
      toolContext,
    };
  }

  return {
    agentName: config.agentName,
    scope: config.scope,
    async activeTurn(context) {
      const turn = await input.readActiveTurn(context);
      if (!turn) {
        throw new Error("PI_AGENT_TURN_UNAVAILABLE: no turn owns this agent's current work.");
      }
      return createTurnContext(turn);
    },
    turn: createTurnContext,
  };
}
