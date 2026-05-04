import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  PiActiveSessionReplayBuffer,
  PiActiveSessionState,
  PiActiveSessionSubscriber,
  PiActiveSessionUpdate,
  PiAgentLoopState,
  PiAgentLoopWaitingFor,
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

const getActiveSessionReplayBuffer = (state: PiAgentLoopState): PiActiveSessionReplayBuffer => {
  const replayBuffer = (state as { activeSessionUpdatesByTurn?: unknown })
    .activeSessionUpdatesByTurn;
  return Array.isArray(replayBuffer)
    ? structuredClone(replayBuffer as PiActiveSessionReplayBuffer)
    : [];
};

export const createPiActiveSessionState = (options?: {
  replayBuffer?: PiActiveSessionReplayBuffer;
  onReplayBufferChange?: (buffer: PiActiveSessionReplayBuffer) => void;
}): PiActiveSessionState => {
  const listeners = new Set<PiActiveSessionSubscriber>();
  const updatesByTurn = new Map<number, PiActiveSessionUpdate[]>();
  let liveController: PiLiveOperationController | null = null;
  const liveInjections = new Map<string, PiLiveInjectionRecord>();

  const trimPreviousTurns = (turn: number) => {
    for (const previousTurn of updatesByTurn.keys()) {
      if (previousTurn < turn - 1) {
        updatesByTurn.delete(previousTurn);
      }
    }
  };

  const appendUpdate = (turn: number, update: PiActiveSessionUpdate) => {
    const existing = updatesByTurn.get(turn) ?? [];
    updatesByTurn.set(turn, [...existing, structuredClone(update)]);
    trimPreviousTurns(turn);
  };

  const exportReplayBuffer = (): PiActiveSessionReplayBuffer =>
    structuredClone(
      [...updatesByTurn.entries()]
        .sort(([leftTurn], [rightTurn]) => leftTurn - rightTurn)
        .map(([turn, updates]) => ({ turn, updates })),
    );

  const syncReplayBuffer = () => {
    options?.onReplayBufferChange?.(exportReplayBuffer());
  };

  const importReplayBuffer = (buffer: PiActiveSessionReplayBuffer) => {
    updatesByTurn.clear();
    for (const entry of structuredClone(buffer)) {
      for (const update of entry.updates) {
        appendUpdate(entry.turn, update);
      }
    }
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
    publishEvent(turn, event) {
      const update: PiActiveSessionUpdate = { type: "event", turn, event };
      appendUpdate(turn, update);
      syncReplayBuffer();
      notify(update);
    },
    settleTurn(turn, status) {
      const update: PiActiveSessionUpdate = { type: "settled", turn, status };
      appendUpdate(turn, update);
      syncReplayBuffer();
      notify(update);
    },
    replayTurn(turn) {
      return structuredClone(updatesByTurn.get(turn) ?? []);
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
  activeSessionUpdatesByTurn: [],
});

export const ensurePiActiveSessionState = (state: PiAgentLoopState): PiActiveSessionState => {
  if (state.activeSession) {
    return state.activeSession;
  }

  const activeSession = createPiActiveSessionState({
    replayBuffer: getActiveSessionReplayBuffer(state),
    onReplayBufferChange: (replayBuffer) => {
      state.activeSessionUpdatesByTurn = replayBuffer;
    },
  });
  state.activeSessionUpdatesByTurn = activeSession.exportReplayBuffer();
  state.activeSession = activeSession;
  return activeSession;
};
