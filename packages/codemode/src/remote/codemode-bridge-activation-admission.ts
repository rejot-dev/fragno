import { CODEMODE_LIMITS } from "../codemode-limits";

// Shared across authenticated clients in this Worker isolate, independently of compiler admission.
let activeBridgeActivations = 0;

/** The owner releases bridge admission only after guest execution and forwarded host-call settlement. */
export function reserveCodemodeBridgeActivation(): () => void {
  if (activeBridgeActivations >= CODEMODE_LIMITS.maxBridgeActivations) {
    throw new Error("CODEMODE_BRIDGE_ACTIVATION_LIMIT_EXCEEDED");
  }
  activeBridgeActivations += 1;
  let released = false;
  return function releaseBridgeActivation() {
    if (!released) {
      released = true;
      activeBridgeActivations -= 1;
    }
  };
}
