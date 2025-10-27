import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig(mergeConfig(baseConfig, {}));
