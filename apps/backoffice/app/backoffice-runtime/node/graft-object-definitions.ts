import { defineNodeRuntimeObject } from "@fragno-private/backoffice-node-runtime/node-runtime-object";

import type { createGraftBackofficeObject } from "./graft-backoffice.objects";
import type { GraftBackofficeConfiguration } from "./graft-runtime-services";

const graftBackofficeObjectBindings = [
  "API",
  "AUTH",
  "TELEGRAM",
  "RESEND",
  "RESON8",
  "MCP",
  "PROJECT_CONNECTOR",
  "OTP",
  "UPLOAD",
  "SANDBOX_MANAGER",
  "GITHUB",
  "GITHUB_WEBHOOK_ROUTER",
  "CLOUDFLARE",
  "FORMS",
  "AUTOMATIONS",
  "PI",
  "PI_MANAGER",
  "BILLING",
  "MARKETPLACE",
] as const;

/** Sandbox containers remain external; their manager and every application object run in workers. */
export type GraftBackofficeObjectBinding = (typeof graftBackofficeObjectBindings)[number];

/** The module URL must refer to the built worker entry, not the HTTP process bundle. */
export function defineGraftBackofficeObjects(
  moduleUrl: URL,
  configuration: GraftBackofficeConfiguration,
) {
  return Object.fromEntries(
    graftBackofficeObjectBindings.map((binding) => [
      binding,
      defineNodeRuntimeObject<typeof createGraftBackofficeObject>(
        moduleUrl,
        "createGraftBackofficeObject",
        { binding, configuration },
      ),
    ]),
  );
}
