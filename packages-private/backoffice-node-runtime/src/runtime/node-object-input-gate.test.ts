import { expect, test, assert } from "vitest";

import { NodeObjectInputGate, deliverNodeObjectIO } from "./node-object-input-gate";

test("input turns interleave handlers while external I/O is pending", async () => {
  const gate = new NodeObjectInputGate();
  const entered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<number>();
  const first = gate.runEvent(async () => {
    entered.resolve();
    return await deliverNodeObjectIO(reply.promise);
  });
  try {
    await entered.promise;
    assert((await gate.runEvent(() => 2)) === 2);
    reply.resolve(1);
    assert((await first) === 1);
  } finally {
    reply.resolve(1);
    await first;
    gate.close();
  }
});

test.each([false, true])(
  "foreign completions wait while owner I/O progresses through critical settlement (fail=%s)",
  async (fail) => {
    const gate = new NodeObjectInputGate();
    const readerEntered = Promise.withResolvers<void>();
    const readReply = Promise.withResolvers<void>();
    const criticalEntered = Promise.withResolvers<void>();
    const ownerReply = Promise.withResolvers<void>();
    const ownerProgressed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let readFinished = false;
    let value = 1;
    const reader = gate.runEvent(async () => {
      readerEntered.resolve();
      await deliverNodeObjectIO(readReply.promise);
      readFinished = true;
      return value;
    });
    await readerEntered.promise;
    const critical = gate.runEvent(() =>
      gate.runCriticalSection(async () => {
        criticalEntered.resolve();
        await deliverNodeObjectIO(ownerReply.promise);
        ownerProgressed.resolve();
        await deliverNodeObjectIO(release.promise);
        if (fail) {
          throw new Error("EXPECTED_CRITICAL_FAILURE");
        }
        value = 2;
      }),
    );
    const settled = fail ? expect(critical).rejects.toThrow("EXPECTED_CRITICAL_FAILURE") : critical;
    try {
      await criticalEntered.promise;
      readReply.resolve();
      ownerReply.resolve();
      await ownerProgressed.promise;
      assert(!readFinished);
      release.resolve();
      await settled;
      expect(await reader).toBe(fail ? 1 : 2);
      assert((await gate.runEvent(() => 3)) === 3);
    } finally {
      readReply.resolve();
      ownerReply.resolve();
      release.resolve();
      await Promise.allSettled([reader, settled]);
      gate.close();
    }
  },
);

test("critical acquisition occurs after already-ready microtasks have drained", async () => {
  const gate = new NodeObjectInputGate();
  let reading = true;
  const read = gate.runOperation(async () => {
    for (let index = 0; index < 30; index++) {
      await Promise.resolve();
    }
    reading = false;
  });
  const critical = gate.runOperation(() =>
    gate.runCriticalSection(() => {
      assert(!reading);
    }),
  );
  try {
    await Promise.all([read, critical]);
  } finally {
    gate.close();
  }
});

test("nested critical sections preserve parent exclusivity and descendant I/O admission", async () => {
  const gate = new NodeObjectInputGate();
  const childEntered = Promise.withResolvers<void>();
  const childReply = Promise.withResolvers<void>();
  const parentReply = Promise.withResolvers<void>();
  let parentFinished = false;
  let foreignFinished = false;
  const outer = gate.runEvent(() =>
    gate.runCriticalSection(async () => {
      const parentInput = deliverNodeObjectIO(parentReply.promise).then(() => {
        parentFinished = true;
      });
      await gate.runCriticalSection(async () => {
        childEntered.resolve();
        await deliverNodeObjectIO(childReply.promise);
        assert(!parentFinished);
        assert(!foreignFinished);
      });
      await parentInput;
    }),
  );
  await childEntered.promise;
  const foreign = gate.runEvent(() => {
    foreignFinished = true;
  });
  try {
    parentReply.resolve();
    childReply.resolve();
    await outer;
    assert(parentFinished);
    await foreign;
    assert(foreignFinished);
  } finally {
    parentReply.resolve();
    childReply.resolve();
    await Promise.allSettled([outer, foreign]);
    gate.close();
  }
});

test("admitted callback work remains pending until its asynchronous body settles", async () => {
  const gate = new NodeObjectInputGate();
  let completedInputs = 0;
  gate.setInputSettledListener(() => {
    completedInputs += 1;
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const callback = gate.runOperation(() =>
    gate.bindInput(async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  const result = callback();
  try {
    await entered.promise;
    assert(gate.hasPendingInput);
    release.resolve();
    await result;
    // Let the gate's already-scheduled final turn drain too.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert(!gate.hasPendingInput);
    assert(completedInputs === 1);
  } finally {
    release.resolve();
    await result;
    gate.close();
  }
});

test("closing an input gate rejects queued foreign work without blocking maintenance", async () => {
  const gate = new NodeObjectInputGate();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const critical = gate.runEvent(() =>
    gate.runCriticalSection(async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  await entered.promise;
  const queued = gate.runEvent(() => "must not run");
  const rejected = expect(queued).rejects.toThrow("NODE_OBJECT_INPUT_GATE_CLOSED");
  try {
    assert(
      (await gate.runMaintenance(() => deliverNodeObjectIO(Promise.resolve("cleanup")))) ===
        "cleanup",
    );
    gate.close();
    await rejected;
  } finally {
    release.resolve();
    await critical;
    gate.close();
  }
});
