import { describe, expect, it, vi } from "vitest";

import type { WorkflowStepEmissionStreamBus } from "./stream-step-emissions";
import { streamWorkflowStepEmissions } from "./stream-step-emissions";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type Frame = { type: string; value?: string };

type FakeStream = {
  writes: Frame[];
  write: ReturnType<typeof vi.fn<(frame: Frame) => Promise<void>>>;
  onAbort: ReturnType<typeof vi.fn<(listener: () => void) => void>>;
  abort: () => void;
};

const createFakeStream = (options?: { blockOn?: string }): FakeStream & { unblock: () => void } => {
  const blocked = createDeferred();
  let abortListener = () => {};
  const writes: Frame[] = [];

  return {
    writes,
    write: vi.fn(async (frame: Frame) => {
      writes.push(frame);
      if (frame.type === options?.blockOn) {
        await blocked.promise;
      }
    }),
    onAbort: vi.fn((listener: () => void) => {
      abortListener = listener;
    }),
    abort: () => abortListener(),
    unblock: blocked.resolve,
  };
};

const createFakeBus = () => {
  let outboundHandler:
    | ((message: {
        stepKey: string;
        epoch: string;
        id: string;
        sequence: number;
        actor: "user";
        payload: Frame;
        createdAt: Date;
      }) => void | Promise<void>)
    | undefined;
  const bus = {
    observe: vi.fn(
      (
        handler: (message: {
          stepKey: string;
          epoch: string;
          id: string;
          sequence: number;
          actor: "user";
          payload: Frame;
          createdAt: Date;
        }) => void | Promise<void>,
      ) => {
        outboundHandler = handler;
        return vi.fn();
      },
    ),
  } satisfies WorkflowStepEmissionStreamBus<Frame>;

  return {
    bus,
    emit: (payload: Frame) =>
      outboundHandler?.({
        id: `fake-${payload.type}`,
        stepKey: "fake",
        epoch: "0",
        sequence: 0,
        actor: "user",
        payload,
        createdAt: new Date(),
      }),
  };
};

const waitForMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("streamWorkflowStepEmissions", () => {
  it("serializes writes without blocking outbound observers", async () => {
    const stream = createFakeStream({ blockOn: "blocked" });
    const { bus, emit } = createFakeBus();

    const run = streamWorkflowStepEmissions({
      stream,
      emissionBus: bus,
      initialEmissions: [{ type: "snapshot" }],
    });

    await waitForMicrotasks();
    expect(stream.writes).toEqual([{ type: "snapshot" }]);

    const blockedResult = emit({ type: "blocked" });
    const afterResult = emit({ type: "after" });

    expect(blockedResult).toBeUndefined();
    expect(afterResult).toBeUndefined();

    await waitForMicrotasks();
    expect(stream.writes).toEqual([{ type: "snapshot" }, { type: "blocked" }]);

    stream.unblock();
    await vi.waitFor(() =>
      expect(stream.writes).toEqual([{ type: "snapshot" }, { type: "blocked" }, { type: "after" }]),
    );

    stream.abort();
    await run;
  });
});
