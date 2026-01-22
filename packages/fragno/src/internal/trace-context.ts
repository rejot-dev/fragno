import { AsyncLocalStorage } from "node:async_hooks";

export type FragnoCoreTraceEvent =
  | {
      type: "route-input";
      method: string;
      path: string;
      pathParams: Record<string, string>;
      queryParams: [string, string][];
      headers: [string, string][];
      body: unknown;
    }
  | {
      type: "middleware-decision";
      method: string;
      path: string;
      outcome: "allow" | "deny";
      status?: number;
    };

export type FragnoTraceRecorder = (event: FragnoCoreTraceEvent) => void;

const traceStorage = new AsyncLocalStorage<FragnoTraceRecorder>();

export const runWithTraceRecorder = <T>(recorder: FragnoTraceRecorder, callback: () => T): T =>
  traceStorage.run(recorder, callback);

export const getTraceRecorder = (): FragnoTraceRecorder | undefined => traceStorage.getStore();

export const recordTraceEvent = (event: FragnoCoreTraceEvent): void => {
  const recorder = traceStorage.getStore();
  if (recorder) {
    recorder(event);
  }
};
