import type { CodemodeRunner } from "../codemode/codemode-object-execute";
import { runBackofficeCodemode } from "../codemode/execute";
import type { PiCodemodeRuntime } from "./pi-tools";

export const createPiCodemodeRuntime = (codemode: CodemodeRunner): PiCodemodeRuntime => ({
  execute: (input) => runBackofficeCodemode({ ...input, codemode }),
});

export const createUnavailablePiCodemodeRuntime = (): PiCodemodeRuntime => ({
  execute: async () => {
    throw new Error("Pi codemode is unavailable because the Worker Loader is not configured.");
  },
});
