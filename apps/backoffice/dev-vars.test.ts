import { expect, test } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { experimental_readRawConfig } from "wrangler";

// Read by the Node target only, which loads every .dev.vars key into process.env.
const NODE_ONLY_KEYS = [
  "BACKOFFICE_SQLITE_DIR",
  "BACKOFFICE_TRUST_PROXY",
  "CLOUDFLARE_BRIDGE_URL",
  "CLOUDFLARE_BRIDGE_API_KEY",
];

function readKeys(path: string, pattern: RegExp): string[] {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function readDeclaredKeys(path: string): string[] {
  const { rawConfig } = experimental_readRawConfig({
    config: fileURLToPath(new URL(path, import.meta.url)),
  });
  return [...Object.keys(rawConfig.vars ?? {}), ...(rawConfig.secrets?.required ?? [])];
}

test("Cloudflare dev and preview load every .dev.vars.example key except Node-only keys and optional secrets", () => {
  const exampleKeys = readKeys("./.dev.vars.example", /^([A-Z][A-Z0-9_]*)=/gmu);
  const knownKeys = new Set([
    ...readDeclaredKeys("./wrangler.jsonc"),
    ...readDeclaredKeys("./wrangler.web.jsonc"),
    ...readKeys("./optional-secrets.d.ts", /^\s+([A-Z][A-Z0-9_]*)\?: string;$/gmu),
    ...NODE_ONLY_KEYS,
  ]);

  // Wrangler drops undeclared keys without a warning. Declare a setting in `vars` with its deployed
  // default, or a secret in `secrets.required`.
  expect(exampleKeys.filter((key) => !knownKeys.has(key))).toEqual([]);
});
