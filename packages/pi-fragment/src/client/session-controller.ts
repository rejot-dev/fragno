import { computed, type ReadableAtom } from "nanostores";

import {
  createPiSessionStore,
  type CreatePiSessionStoreDependencies,
  type PiSessionStoreController,
  type PiSessionStoreState,
} from "./session-store";
import type { PiSessionDetail } from "../pi/types";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

export type PiSessionStoreHookArgs = {
  path: { sessionId: string };
  initialData?: PiSessionDetail | null;
};

export type PiSessionStoreView = {
  loading: ReadableAtom<PiSessionStoreState["loading"]>;
  session: ReadableAtom<PiSessionStoreState["session"]>;
  messages: ReadableAtom<AgentMessage[]>;
  traceEvents: ReadableAtom<AgentEvent[]>;
  runningTools: ReadableAtom<PiSessionStoreState["runningTools"]>;
  connection: ReadableAtom<PiSessionStoreState["connection"]>;
  statusText: ReadableAtom<PiSessionStoreState["statusText"]>;
  readyForInput: ReadableAtom<PiSessionStoreState["readyForInput"]>;
  sending: ReadableAtom<PiSessionStoreState["sending"]>;
  error: ReadableAtom<PiSessionStoreState["error"]>;
  sendError: ReadableAtom<PiSessionStoreState["sendError"]>;
  sendMessage: PiSessionStoreController["sendMessage"];
  refetch: PiSessionStoreController["refetch"];
  [Symbol.dispose]: () => void;
};

const select = <T>(
  store: ReadableAtom<PiSessionStoreState>,
  selector: (state: PiSessionStoreState) => T,
) => computed(store, selector);

export function createPiSessionControllerStore(
  input: CreatePiSessionStoreDependencies,
): (args: PiSessionStoreHookArgs) => PiSessionStoreView {
  return ({ path, initialData }) => {
    const controller = createPiSessionStore(input, {
      sessionId: path.sessionId,
      initialData,
    });

    return {
      loading: select(controller.store, (state) => state.loading),
      session: select(controller.store, (state) => state.session),
      messages: select(controller.store, (state) => state.messages),
      traceEvents: select(controller.store, (state) => state.traceEvents),
      runningTools: select(controller.store, (state) => state.runningTools),
      connection: select(controller.store, (state) => state.connection),
      statusText: select(controller.store, (state) => state.statusText),
      readyForInput: select(controller.store, (state) => state.readyForInput),
      sending: select(controller.store, (state) => state.sending),
      error: select(controller.store, (state) => state.error),
      sendError: select(controller.store, (state) => state.sendError),
      sendMessage: controller.sendMessage,
      refetch: controller.refetch,
      // React store factories may dispose during dev StrictMode or transitional rerenders.
      // Use the lighter controller cleanup here so live subscriptions are torn down without
      // permanently poisoning the session store instance.
      [Symbol.dispose]: controller.deactivate,
    };
  };
}
