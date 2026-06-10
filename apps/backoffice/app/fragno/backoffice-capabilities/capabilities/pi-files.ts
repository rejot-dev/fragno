import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createPiCapabilityFiles = () =>
  skillFiles({
    name: "pi-connection",
    title: "Pi Connection",
    description:
      "Configure and automate Backoffice Pi agents. Use when setting model provider keys, configuring harnesses, handling pi:capability.configured events, creating Pi sessions, or running Pi turns from automations.",
    overview:
      "Use this skill for Pi model provider configuration, harness setup, Pi session automation, and Pi capability events.",
    configuration: `# Pi configuration

Configuration fields:

- \`apiKeys.openai\`: OpenAI API key. Secret.
- \`apiKeys.anthropic\`: Anthropic API key. Secret.
- \`apiKeys.gemini\`: Gemini API key. Secret.
- \`harnesses\`: harness configuration array.

Setup notes:

- Configure at least one model provider API key.
- Configure at least one harness before creating sessions.
`,
    events: `# Pi events

## pi:capability.configured

Fires after Pi is configured for an organisation for the first time.

Payload fields:

- \`capabilityId\`: \`pi\`.
- \`capabilityLabel\`: \`Pi\`.
- \`harnesses\`: configured harness summaries with id, label, description, and tool names.
- \`modelCatalog\`: available model provider/name/label entries.

Subject:

- \`orgId\`: organisation id.
- \`capabilityId\`: \`pi\`.

Common automation pattern: store a default agent binding from the first available harness and model, then use it when routing chat messages into Pi sessions.

Hook scopes: \`pi\`, \`pi-workflows\`.
`,
    tools: `# Pi tools

Pi tools can:

- create sessions;
- list sessions;
- retrieve session details;
- run a turn in an existing session.

Use codemode first. The \`pi\` provider methods are \`createSession\`, \`listSessions\`, \`getSession\`, and \`runTurn\`.
`,
  });
