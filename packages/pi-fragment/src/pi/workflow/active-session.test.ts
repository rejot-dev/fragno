import { describe, expect, it, vi } from "vitest";

import { createPiActiveSessionState } from "./active-session";

describe("createPiActiveSessionState live injection", () => {
  it("best-effort injects abort, steer, and followUp into the registered live controller", () => {
    const activeSession = createPiActiveSessionState();
    const abort = vi.fn();
    const steer = vi.fn();
    const followUp = vi.fn();

    activeSession.registerLiveController({
      turn: 2,
      operation: "prompt",
      stepKey: "do:prompt-turn-2-op-0",
      abort,
      steer,
      followUp,
    });

    const steerInput = { text: "nudge" };
    const followUpInput = { text: "next" };

    expect(activeSession.recordLiveInjection("abort-1", "abort")).toMatchObject({
      commandId: "abort-1",
      commandKind: "abort",
      attempted: true,
      controllerPresent: true,
      injected: true,
      turn: 2,
      stepKey: "do:prompt-turn-2-op-0",
    });
    expect(activeSession.recordLiveInjection("steer-1", "steer", steerInput)).toMatchObject({
      commandId: "steer-1",
      commandKind: "steer",
      attempted: true,
      controllerPresent: true,
      injected: true,
      turn: 2,
      stepKey: "do:prompt-turn-2-op-0",
    });
    expect(activeSession.recordLiveInjection("follow-1", "followUp", followUpInput)).toMatchObject({
      commandId: "follow-1",
      commandKind: "followUp",
      attempted: true,
      controllerPresent: true,
      injected: true,
      turn: 2,
      stepKey: "do:prompt-turn-2-op-0",
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(steerInput);
    expect(followUp).toHaveBeenCalledWith(followUpInput);
    expect(activeSession.getLiveInjection("steer-1")).toMatchObject({ injected: true });
  });

  it("records a non-injected command when no live controller exists", () => {
    const activeSession = createPiActiveSessionState();

    expect(activeSession.recordLiveInjection("steer-1", "steer", { text: "nudge" })).toMatchObject({
      commandId: "steer-1",
      commandKind: "steer",
      attempted: true,
      controllerPresent: false,
      injected: false,
      turn: null,
      stepKey: null,
    });
  });
});
