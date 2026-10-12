import type { CodemodeObject } from "@/backoffice-runtime/object-registry";

import { runBackofficeCodemode } from "../codemode/execute";
import type { PiCodemodeRuntime } from "./pi-tools";

export const createPiCodemodeRuntime = (codemode: CodemodeObject): PiCodemodeRuntime => ({
  execute: (input) => runBackofficeCodemode({ ...input, codemode }),
});

export const createUnavailablePiCodemodeRuntime = (): PiCodemodeRuntime => ({
  execute: async () => {
    throw new Error("Pi codemode is unavailable because the Worker Loader is not configured.");
  },
});
