import { runBackofficeCodemode, type BackofficeCodemodeEnv } from "../codemode/execute";
import type { PiCodemodeRuntime } from "./pi";

export const createPiCodemodeRuntime = (env: BackofficeCodemodeEnv): PiCodemodeRuntime => ({
  execute: (input) => runBackofficeCodemode({ ...input, env }),
});

export const createUnavailablePiCodemodeRuntime = (): PiCodemodeRuntime => ({
  execute: async () => {
    throw new Error("Pi codemode is unavailable because the Worker Loader is not configured.");
  },
});
