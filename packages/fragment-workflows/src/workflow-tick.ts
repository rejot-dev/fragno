/**
 * How one step call ended for workflow code. `order` is the step's place in the settle order, or
 * null for a step that has none, such as one that failed before it recorded anything.
 */
export type WorkflowStepCallOutcome<T = unknown> =
  | { type: "settled"; ok: true; value: T; order: number | null }
  | { type: "settled"; ok: false; error: unknown; order: number | null }
  // The step waits for a later tick, so its promise stays pending in this one.
  | { type: "parked" };

/** How a tick of workflow code ended. */
export type WorkflowTickEnd =
  | { type: "returned"; value: unknown }
  | { type: "threw"; error: unknown }
  // Nothing settled the run, no step call is in flight, and the code starts no new ones.
  | { type: "idle" };

export type WorkflowTick = {
  /** The order of a step that settled this tick. */
  record(): number;
  /** Whether the tick ended, and whether the run had settled by then. */
  ended(): "settled" | "unsettled" | null;
  /**
   * Runs one step call. A parked step's promise never settles; a settled step waits for its turn
   * in the settle order. A `start` that rejects broke the step machinery rather than the step:
   * the tick ends with its error, and workflow code cannot catch it.
   */
  call(start: () => Promise<WorkflowStepCallOutcome>): Promise<unknown>;
  /**
   * Runs workflow code for one tick. The tick ends once no step call is in flight and either the
   * code has settled, or a whole macrotask turn starts no new step call: workflow code awaits only
   * steps, so nothing can make progress any more. Steps still running when the code settles finish
   * first, since their outcomes belong to this tick.
   */
  run(body: () => Promise<unknown>): Promise<WorkflowTickEnd>;
};

/**
 * Drives one tick of workflow code, wherever it runs: the runner runs local workflows with it, and
 * remote guests run it beside their workflow code, since only the realm running the code can tell
 * when it stops making progress.
 *
 * It hands settled steps back to workflow code in the order they first settled, so code racing
 * steps decides the same way on every replay. Steps settled in earlier ticks come back in their
 * recorded order; steps settling this tick follow every one of them, in the order they settle,
 * which they record contiguously from just after the last replayed order. It hands back one step
 * per macrotask turn, so workflow code reacts to each settlement fully before it sees the next.
 *
 * Remote guests run this function's source, so it references nothing outside itself.
 */
export function createWorkflowTick(replayedOrders: readonly number[]): WorkflowTick {
  /** Replayed settlements not yet handed back, ascending. */
  const replayed = replayedOrders.toSorted((left, right) => left - right);
  const lastReplayed = replayed.at(-1) ?? -1;
  let nextRecorded = lastReplayed + 1;
  /** The fresh settlement to hand back next; a remote guest can receive them out of order. */
  let nextFresh = lastReplayed + 1;
  /** Steps waiting for their turn, in the order they arrived. */
  const waiting: Array<{ order: number; release: () => void }> = [];
  let releasing = false;

  /** Step calls started this tick, to tell whether workflow code still makes progress. */
  let calls = 0;
  /** Step calls neither settled nor parked yet. */
  let active = 0;
  let onIdle: Array<() => void> = [];
  let broken: { error: unknown } | null = null;
  let ended: "settled" | "unsettled" | null = null;

  /** One macrotask turn, which runs every microtask queued before it. */
  const nextMacrotask = () =>
    new Promise<void>((resolve) => {
      // Tests fake setTimeout, not setImmediate; workerd provides setImmediate under nodejs_compat.
      if (typeof setImmediate === "function") {
        setImmediate(resolve);
      } else {
        setTimeout(resolve, 0);
      }
    });

  /**
   * The next waiter to hand back. While replayed settlements are left, a replayed step no later
   * than the earliest of them, which includes replayed steps whose turn was skipped. After that,
   * any replayed step, then the next fresh settlement.
   */
  const dueIndex = () => {
    const head = replayed[0];
    if (head !== undefined) {
      return waiting.findIndex((waiter) => waiter.order <= head);
    }
    const skipped = waiting.findIndex((waiter) => waiter.order <= lastReplayed);
    return skipped !== -1 ? skipped : waiting.findIndex((waiter) => waiter.order === nextFresh);
  };

  const releaseNext = () => {
    if (releasing) {
      return;
    }
    const index = dueIndex();
    if (index === -1) {
      return;
    }
    const [waiter] = waiting.splice(index, 1);
    if (waiter.order === replayed[0]) {
      replayed.shift();
    }
    if (waiter.order === nextFresh) {
      nextFresh += 1;
    }
    waiter.release();
    releasing = true;
    void nextMacrotask().then(() => {
      releasing = false;
      releaseNext();
    });
  };

  const turn = (order: number) =>
    new Promise<void>((release) => {
      waiting.push({ order, release });
      releaseNext();
    });

  /**
   * Gives up on the replayed settlements earlier than every waiting replayed step, which this tick
   * will not ask for, such as after the code changed. Returns whether it gave any up.
   */
  const skipMissing = () => {
    if (waiting.length === 0) {
      return false;
    }
    const lowest = Math.min(
      ...waiting.map((waiter) =>
        waiter.order <= lastReplayed ? waiter.order : Number.POSITIVE_INFINITY,
      ),
    );
    let skipped = false;
    while (replayed.length > 0 && replayed[0] < lowest) {
      replayed.shift();
      skipped = true;
    }
    releaseNext();
    return skipped;
  };

  const untilIdle = () =>
    active === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          onIdle.push(resolve);
        });

  const leave = () => {
    active -= 1;
    if (active === 0) {
      const resolvers = onIdle;
      onIdle = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  };

  const never = () => new Promise<never>(() => {});

  return {
    record: () => nextRecorded++,
    ended: () => ended,
    async call(start) {
      if (ended !== null) {
        return await never();
      }
      calls += 1;
      active += 1;
      let outcome: WorkflowStepCallOutcome;
      try {
        outcome = await start();
      } catch (error) {
        broken ??= { error };
        leave();
        return await never();
      }
      leave();
      if (outcome.type === "parked") {
        return await never();
      }
      if (outcome.order !== null) {
        await turn(outcome.order);
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
      return outcome.value;
    },
    async run(body) {
      let settled: WorkflowTickEnd | null = null;
      const runSettles = (async () => await body())().then(
        (value) => {
          settled = { type: "returned", value };
        },
        (error: unknown) => {
          settled = { type: "threw", error };
        },
      );
      for (;;) {
        await untilIdle();
        // Steps that branches left behind would start now cannot change how the run ended.
        if (settled || broken) {
          break;
        }
        const started = calls;
        await Promise.race([nextMacrotask(), runSettles]);
        if (settled || active > 0 || calls !== started || releasing || dueIndex() !== -1) {
          continue;
        }
        if (skipMissing()) {
          continue;
        }
        break;
      }
      ended = settled || broken ? "settled" : "unsettled";
      if (broken) {
        return { type: "threw", error: broken.error };
      }
      return settled ?? { type: "idle" };
    },
  };
}
