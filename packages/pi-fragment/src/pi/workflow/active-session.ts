import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type {
  PiActiveSessionReplayBuffer,
  PiActiveSessionState,
  PiActiveSessionSubscriber,
  PiActiveSessionUpdate,
  PiAgentLoopState,
  PiAgentLoopWaitingFor,
} from "../types";

const WAIT_FOR_USER_TIMEOUT_MS = 60 * 60 * 1000;

const buildWaitingForUser = (turn: number): NonNullable<PiAgentLoopWaitingFor> => ({
  type: "user_message",
  turn,
  stepKey: `waitForEvent:wait-user-${turn}`,
  timeoutMs: WAIT_FOR_USER_TIMEOUT_MS,
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
  };
};

export const createInitialPiAgentLoopState = (messages: AgentMessage[] = []): PiAgentLoopState => ({
  messages,
  events: [],
  trace: [],
  summaries: [],
  turn: 0,
  phase: "waiting-for-user",
  waitingFor: buildWaitingForUser(0),
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
