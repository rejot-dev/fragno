import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nativeSetImmediate } from "node:timers";

const dispatchInputTurn = nativeSetImmediate;

type CriticalSection = {
  parent: CriticalSection | null;
  state: "reserved" | "running" | "released";
};

type ObjectExecutionContext = {
  gate: NodeObjectInputGate;
  owner: symbol;
  mode: "application" | "maintenance";
  section: CriticalSection | null;
};

type InputJob = {
  kind: "input" | "critical";
  section: CriticalSection | null;
  run(): void;
  reject(error: Error): void;
};

const executionContext = new AsyncLocalStorage<ObjectExecutionContext>();

/** Schedules object input turns; critical sections gate completions, never entire handlers. */
export class NodeObjectInputGate {
  readonly #jobs: InputJob[] = [];
  #criticalSection: CriticalSection | null = null;
  #turnContext: ObjectExecutionContext | null = null;
  #scheduled = false;
  #runningInputs = 0;
  #failure: Error | null = null;
  #inputSettledListener: (() => void) | null = null;

  get operationOwner(): symbol | null {
    const context = executionContext.getStore();
    return context?.gate === this ? context.owner : null;
  }

  get hasPendingInput(): boolean {
    return this.#jobs.length > 0 || this.#scheduled || this.#runningInputs > 0;
  }

  setInputSettledListener(listener: (() => void) | null): void {
    this.#inputSettledListener = listener;
  }

  runOperation<TResult>(operation: () => TResult): TResult {
    const context = executionContext.getStore();
    if (context?.gate === this) {
      return operation();
    }
    return executionContext.run(
      { gate: this, owner: Symbol("node object operation"), mode: "application", section: null },
      operation,
    );
  }

  runMaintenance<TResult>(operation: () => TResult): TResult {
    return executionContext.run(
      { gate: this, owner: Symbol("node object maintenance"), mode: "maintenance", section: null },
      operation,
    );
  }

  runEvent<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    return executionContext.run(
      { gate: this, owner: Symbol("node object event"), mode: "application", section: null },
      () => this.runInput(operation),
    );
  }

  runInput<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    return this.runOperation(() => {
      const context = this.#captureContext();
      if (context.mode === "maintenance") {
        return Promise.resolve().then(operation);
      }
      return this.#enqueue(context, "input", context.section, operation);
    });
  }

  runCriticalSection<TResult>(operation: () => TResult | Promise<TResult>): Promise<TResult> {
    return this.runOperation(() => {
      const context = this.#captureContext();
      const section: CriticalSection = {
        parent: context.section,
        state: "reserved",
      };
      return this.#enqueue(context, "critical", section, operation);
    });
  }

  deliver<TResult>(promise: PromiseLike<TResult>): Promise<TResult> {
    const context = this.#captureContext();
    if (context.mode === "maintenance") {
      return Promise.resolve(promise);
    }
    const restore = AsyncLocalStorage.snapshot();
    const delivered = Promise.withResolvers<TResult>();
    void Promise.resolve(promise).then(
      (value) => {
        void restore(() => this.#enqueue(context, "input", context.section, () => value)).then(
          delivered.resolve,
          delivered.reject,
        );
      },
      (error: unknown) => {
        void restore(() =>
          this.#enqueue(context, "input", context.section, () => {
            throw error;
          }),
        ).then(delivered.resolve, delivered.reject);
      },
    );
    return delivered.promise;
  }

  bindInput<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
  ): (...args: TArgs) => Promise<Awaited<TResult>> {
    const context = this.#captureContext();
    const restore = AsyncLocalStorage.snapshot();
    return (...args) =>
      restore(() => this.#enqueue(context, "input", context.section, () => callback(...args)));
  }

  close(): void {
    this.#failure ??= new Error("NODE_OBJECT_INPUT_GATE_CLOSED");
    for (const job of this.#jobs.splice(0)) {
      job.reject(this.#failure);
    }
  }

  #captureContext(): ObjectExecutionContext {
    const context = executionContext.getStore()!;
    let section = context.section;
    // Kysely's caller continuations predate the storage callback. The permitted execution turn
    // carries its critical section even when their lexical async context still names the parent.
    if (this.#turnContext?.owner === context.owner) {
      section = this.#turnContext.section;
    }
    return { ...context, section: liveSection(section) };
  }

  #enqueue<TResult>(
    context: ObjectExecutionContext,
    kind: InputJob["kind"],
    section: CriticalSection | null,
    operation: () => TResult | PromiseLike<TResult>,
  ): Promise<Awaited<TResult>> {
    if (this.#failure) {
      return Promise.reject(this.#failure);
    }
    const outcome = Promise.withResolvers<Awaited<TResult>>();
    const restore = AsyncLocalStorage.snapshot();
    this.#jobs.push({
      kind,
      section,
      reject: outcome.reject,
      run: () => {
        this.#runningInputs += 1;
        const turnContext = { ...context, section: liveSection(section) };
        this.#turnContext = turnContext;
        if (kind === "critical") {
          section!.state = "running";
          this.#criticalSection = section;
        }
        let result: TResult | PromiseLike<TResult>;
        try {
          result = restore(() => executionContext.run(turnContext, operation));
        } catch (error) {
          this.#finishInputJob(kind, section);
          outcome.reject(error);
          return;
        }
        void Promise.resolve(result).then(
          (value) => {
            this.#finishInputJob(kind, section);
            outcome.resolve(value);
          },
          (error: unknown) => {
            this.#finishInputJob(kind, section);
            outcome.reject(error);
          },
        );
      },
    });
    this.#scheduleTurn();
    return outcome.promise;
  }

  #finishInputJob(kind: InputJob["kind"], section: CriticalSection | null): void {
    this.#runningInputs -= 1;
    this.#inputSettledListener?.();
    if (kind === "critical") {
      section!.state = "released";
      this.#criticalSection = liveSection(section!.parent);
    }
    this.#scheduleTurn();
  }

  #nextJobIndex(): number {
    const permitted = (job: InputJob) => {
      const scope = job.kind === "critical" ? job.section!.parent : job.section;
      return this.#criticalSection === null || descendsFrom(scope, this.#criticalSection);
    };
    const critical = this.#jobs.findIndex((job) => job.kind === "critical" && permitted(job));
    return critical === -1 ? this.#jobs.findIndex(permitted) : critical;
  }

  #scheduleTurn(): void {
    if (this.#scheduled || this.#failure || this.#nextJobIndex() === -1) {
      return;
    }
    this.#scheduled = true;
    // A macrotask boundary drains already-ready promise continuations before SQLite BEGIN.
    // The scheduler uses the original timer, not the application I/O facade it drives.
    dispatchInputTurn(() => {
      this.#scheduled = false;
      if (this.#failure) {
        return;
      }
      const index = this.#nextJobIndex();
      if (index !== -1) {
        const [job] = this.#jobs.splice(index, 1);
        job.run();
      }
      this.#scheduleTurn();
    });
  }
}

/** Delivers native I/O only in the application's captured input scope; maintenance bypasses it. */
export function deliverNodeObjectIO<TResult>(promise: PromiseLike<TResult>): Promise<TResult> {
  const context = executionContext.getStore();
  return context?.mode === "application" ? context.gate.deliver(promise) : Promise.resolve(promise);
}

/** Captures callback admission before a native API can resume an already-running object handler. */
export function bindNodeObjectInput<TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): ((...args: TArgs) => Promise<Awaited<TResult>>) | null {
  const context = executionContext.getStore();
  return context?.mode === "application" ? context.gate.bindInput(callback) : null;
}

/** Native listener registration and runtime control never acquire an application input scope. */
export function runOutsideNodeObjectInput<TResult>(operation: () => TResult): TResult {
  return executionContext.exit(operation);
}

function liveSection(section: CriticalSection | null): CriticalSection | null {
  while (section?.state === "released") {
    section = section.parent;
  }
  return section;
}

function descendsFrom(section: CriticalSection | null, ancestor: CriticalSection): boolean {
  for (let current = liveSection(section); current; current = liveSection(current.parent)) {
    if (current === ancestor) {
      return true;
    }
  }
  return false;
}
