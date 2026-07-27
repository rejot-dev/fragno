import type { MarketplaceStaticEntry } from "./contracts";

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
  },
] as const satisfies readonly MarketplaceStaticEntry[];
