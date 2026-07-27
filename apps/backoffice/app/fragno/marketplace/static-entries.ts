import { TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE } from "@/files/content/telegram-test-command";

import type { MarketplaceStaticArtifactEntry } from "./artifacts";

export const STATIC_MARKETPLACE_ENTRIES = [
  {
    owner: {
      scope: { kind: "system" },
      publisherName: "Fragno",
    },
    slug: "telegram-test-command",
    version: "1.0.0",
    metadata: {
      name: "Telegram test command",
      summary: "Send a delayed Telegram reply when a chat receives the /test command.",
      description:
        "A small durable workflow for verifying that Telegram events, workflow sleeps, and delayed replies are configured correctly.",
      category: "communication",
      tags: ["telegram", "testing", "workflow"],
    },
    files: {
      "automations/telegram-test-command.workflow.js": TELEGRAM_TEST_COMMAND_WORKFLOW_SOURCE,
    },
  },
] as const satisfies readonly MarketplaceStaticArtifactEntry[];

export const getStaticMarketplaceEntry = (input: { slug: string; version: string }) =>
  STATIC_MARKETPLACE_ENTRIES.find(
    (entry) => entry.slug === input.slug && entry.version === input.version,
  ) ?? null;
