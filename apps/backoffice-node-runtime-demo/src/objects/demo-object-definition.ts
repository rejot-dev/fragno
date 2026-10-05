import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type { createDemoObject } from "./demo-object";

/** Keeps the object factory importable in a runtime-owned worker thread. */
export const demoObjectDefinition = defineNodeRuntimeObject<typeof createDemoObject>(
  new URL("./demo-object.js", import.meta.url),
  "createDemoObject",
);

/** Object names shown before lazy provisioning creates any durable object logs. */
export const demoDefaultObjectNames = ["demo", "secondary"] as const;

/** Restricts demo object names to URL-safe identities of at most 64 characters. */
export const demoObjectNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
