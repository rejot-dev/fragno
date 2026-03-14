import { atom } from "nanostores";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPiSessionControllerStore } from "./session-controller";
import {
  createPiSessionStore,
  type CreatePiSessionStoreDependencies,
  type PiSessionStoreController,
  type PiSessionStoreState,
} from "./session-store";

vi.mock("./session-store", async () => {
  const actual = await vi.importActual<typeof import("./session-store")>("./session-store");
  return {
    ...actual,
    createPiSessionStore: vi.fn(),
  };
});

const baseState: PiSessionStoreState = {
  loading: false,
  session: null,
  messages: [],
  traceEvents: [],
  runningTools: [],
  connection: "idle",
  statusText: null,
  readyForInput: true,
  sending: false,
  error: null,
  sendError: null,
};

const sessionStoreDeps = {
  createDetailStore: vi.fn(),
  sendMessage: vi.fn(),
  buildActiveUrl: vi.fn(() => "http://localhost/api/pi/sessions/session-1/active"),
  fetcher: vi.fn<typeof fetch>(),
} satisfies CreatePiSessionStoreDependencies;

describe("createPiSessionControllerStore", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("deactivates the session controller when the store view is disposed", () => {
    const controller: PiSessionStoreController = {
      store: atom(baseState),
      sendMessage: vi.fn(() => true),
      refetch: vi.fn(),
      deactivate: vi.fn(),
      destroy: vi.fn(),
    };
    vi.mocked(createPiSessionStore).mockReturnValue(controller);

    const createSessionView = createPiSessionControllerStore(sessionStoreDeps);
    const sessionView = createSessionView({
      path: { sessionId: "session-1" },
    });

    expect(createPiSessionStore).toHaveBeenCalledWith(sessionStoreDeps, {
      sessionId: "session-1",
      initialData: undefined,
    });

    sessionView[Symbol.dispose]();

    expect(controller.deactivate).toHaveBeenCalledTimes(1);
    expect(controller.destroy).not.toHaveBeenCalled();
    expect(sessionView.sendMessage).toBe(controller.sendMessage);
    expect(sessionView.refetch).toBe(controller.refetch);
    expect(sessionView.connection.get()).toBe("idle");
  });
});
