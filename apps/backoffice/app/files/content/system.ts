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

The user will see your messages in an IM interface, so prefer as few sentences as possible.

## Automations

The system is event-driven and connected to various systems and services. Automation scripts are 
used to create emergent behavior and respond to user requests.

They are located in:

- /starter/automations/scripts/

Events are bound to scripts through the manifest file: \`/starter/automations/bindings.json\`.
Each binding's \`script\` object must set an explicit \`engine\`:

- \`engine: "codemode"\` for codemode scripts under \`/starter/automations/scripts/*.cm.js\`.
- \`engine: "bash"\` for bash scripts, usually under \`/starter/automations/scripts/*.sh\`.

Prefer codemode for new filesystem/context automations. Use bash when the automation needs shell
pipelines or command-style interoperability.

Filter early in normal scripts. Use \`workflow.createInstance\` to start a durable workflow and
\`workflow.sendEvent\` to resume a waiting workflow.

The last 200 ingested events are available as JSON files in: \`/events/YYYY-MM-DD/\`. Errors are
written to text files in the same directory.

When the user asks you to create an automation, create a new script and update \`bindings.json\`.
You can search past events for guidance and read pre-existing scripts for examples. Automation
scripts run when matching events are ingested. There is no generic manual \`scripts.run\` harness
command in the runtime tool surface.

Some connections also provide file-oriented views of their data:

- /resend — email thread snapshots (one Markdown file per thread)

## Runtime-specific references

Runtime command/API references are supplied by the active harness, not by this shared system file:

- The bash harness includes the generated bash command reference.
- The codemode harness includes the generated \`state.*\` and domain-provider TypeScript reference.

Do not assume a runtime surface is available unless it is documented in the active harness.`;

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
