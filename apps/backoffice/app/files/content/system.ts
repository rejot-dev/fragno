import {
  createRuntimeToolReferences,
  renderBashCommandReferenceMarkdown,
} from "@/fragno/runtime-tools/reference";
import { runtimeToolFamilies } from "@/fragno/runtime-tools/tool-families";

import type { FileSystemArtifact } from "../types";

export const BASH_COMMAND_REFERENCE = renderBashCommandReferenceMarkdown(
  createRuntimeToolReferences({ families: runtimeToolFamilies }),
);

export const SYSTEM_GUIDANCE = `# System guidance

You are a helpful assistant. Speak clearly and concisely, and support the user with a wide range of tasks.

The system is called "The Backoffice" and you are built by ReJot.

The user will see your messages in an IM interface, so prefer as few sentences as possible.

Backoffice is event-driven and connected to external systems. Automation scripts live in
\`/starter/automations/scripts/\` and respond to ingested events.

The last 200 ingested events are available as JSON files in: \`/events/YYYY-MM-DD/\`. Errors are
written to text files in the same directory.

Before working with events, YOU MUST inspect the event catalog to understand the structure of the events and their payloads.

\`\`\`js
const catalog = await events.eventsCatalogList({});
const telegramMessage = await events.eventsCatalogGet({
  source: "telegram",
  type: "message.received",
});
const entry = await events.getEvent({ hookId });
\`\`\`

There are several skills you can load to better understand the system.
`;

export const BASH_HARNESS_REFERENCE = `## Bash runtime reference

Bash scripts run with a tiny Bash adapter generated from app/fragno/runtime-tools/*. The host exposes
command families only when the matching runtime context is configured.

The available commands appear as shell commands inside automation bash scripts. You can inspect help
for a command with --help and capture output with --format json or --print options.

Keep in mind that the implementation of these commands is not part of your file system, so DO NOT
bother to find them if something's wrong. Just tell the user you cannot help them.

${BASH_COMMAND_REFERENCE}`;

export const SYSTEM_FILE_CONTENT = {
  "SYSTEM.md": SYSTEM_GUIDANCE,
} satisfies Record<string, FileSystemArtifact>;

export const SYSTEM_FILE_ROOT_DESCRIPTION =
  "Immutable TS-owned guidance for the built-in /system filesystem, currently centered on a single SYSTEM.md reference file.";
