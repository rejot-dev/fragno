import { runBackofficeCodemode, type BackofficeCodemodeEnv } from "../codemode/execute";
import type { PiCodemodeRuntime } from "./pi";

export const createPiCodemodeRuntime = (env: BackofficeCodemodeEnv): PiCodemodeRuntime => ({
  env,
  execute: (input) => runBackofficeCodemode(input),
});
