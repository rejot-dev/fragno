import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  PiActiveSessionReplayBuffer,
  PiActiveSessionState,
  PiActiveSessionSubscriber,
  PiActiveSessionUpdate,
  PiAgentLoopState,
  PiAgentLoopWaitingFor,
  PiAgentStateSnapshot,
  PiLiveInjectionRecord,
  PiLiveOperationController,
  PiPromptInput,
  PiSessionCommandType,
} from "../types";

const WAIT_FOR_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

const buildWaitingForCommand = (turn: number): NonNullable<PiAgentLoopWaitingFor> => ({
  type: "command",
  turn,
  stepKey: `waitForEvent:wait-command-turn-${turn}-command-0`,
  allowedCommands: ["prompt", "followUp", "complete"],
  timeoutMs: WAIT_FOR_COMMAND_TIMEOUT_MS,
});

const emptyAgentState = (): PiAgentStateSnapshot => ({
  messages: [],
});

export const createPiActiveSessionState = (options?: {
  replayBuffer?: PiActiveSessionReplayBuffer;
  onReplayBufferChange?: (buffer: PiActiveSessionReplayBuffer) => void;
}): PiActiveSessionState => {
  const listeners = new Set<PiActiveSessionSubscriber>();
  const replayBuffer: PiActiveSessionUpdate[] = [];
  let liveController: PiLiveOperationController | null = null;
  const liveInjections = new Map<string, PiLiveInjectionRecord>();

  const exportReplayBuffer = (): PiActiveSessionReplayBuffer => structuredClone(replayBuffer);

  const syncReplayBuffer = () => {
    options?.onReplayBufferChange?.(exportReplayBuffer());
  };

  const appendUpdate = (update: PiActiveSessionUpdate) => {
    replayBuffer.push(structuredClone(update));
    syncReplayBuffer();
  };

  const importReplayBuffer = (buffer: PiActiveSessionReplayBuffer) => {
    replayBuffer.splice(0, replayBuffer.length, ...structuredClone(buffer));
    syncReplayBuffer();
  };

  if (options?.replayBuffer) {
    importReplayBuffer(options.replayBuffer);
  }

  const notify = (update: PiActiveSessionUpdate) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(update);
      } catch (error) {
        console.warn("Pi active-session listener failed.", { error, updateType: update.type });
      }
    }
  };

  const recordLiveInjection = (
    commandId: string,
    commandKind: Extract<PiSessionCommandType, "abort" | "steer" | "followUp">,
    input?: PiPromptInput,
  ): PiLiveInjectionRecord => {
    const controller = liveController;
    let injected = false;
    if (controller) {
      try {
        if (commandKind === "abort") {
          controller.abort();
        } else if (commandKind === "steer" && input) {
          controller.steer(input);
        } else if (commandKind === "followUp" && input) {
          controller.followUp(input);
        }
        injected = true;
      } catch {
        injected = false;
      }
    }

    const record: PiLiveInjectionRecord = {
      commandId,
      commandKind,
      attempted: true,
      controllerPresent: controller !== null,
      injected,
      turn: controller?.turn ?? null,
      stepKey: controller?.stepKey ?? null,
      createdAt: new Date(),
    };
    liveInjections.set(commandId, record);
    return record;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publishEvent(event) {
      const update: PiActiveSessionUpdate = { type: "event", event };
      appendUpdate(update);
      notify(update);
    },
    settle(state = emptyAgentState()) {
      const update: PiActiveSessionUpdate = { type: "settled", state };
      appendUpdate(update);
      notify(update);
    },
    replay() {
      return exportReplayBuffer();
    },
    exportReplayBuffer,
    importReplayBuffer,
    listenerCount: () => listeners.size,
    registerLiveController(controller) {
      liveController = controller;
    },
    clearLiveController(stepKey) {
      if (liveController?.stepKey === stepKey) {
        liveController = null;
      }
    },
    getLiveController: () => liveController,
    recordLiveInjection,
    getLiveInjection(commandId) {
      return liveInjections.get(commandId) ?? null;
    },
  };
};

export const createInitialPiAgentLoopState = (
  _messages: AgentMessage[] = [],
): PiAgentLoopState => ({
  turn: 0,
  phase: "waiting-for-command",
  waitingFor: buildWaitingForCommand(0),
});

export const ensurePiActiveSessionState = (state: PiAgentLoopState): PiActiveSessionState => {
  if (state.activeSession) {
    return state.activeSession;
  }

  const activeSession = createPiActiveSessionState();
  state.activeSession = activeSession;
  return activeSession;
};
