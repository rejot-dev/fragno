import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createUploadCapabilityFiles = () =>
  skillFiles({
    name: "upload-connection",
    title: "Upload Connection",
    description:
      "Configure the Backoffice Upload storage capability. Use when choosing upload providers, inspecting upload hooks, or debugging organisation-scoped file storage configuration.",
    overview:
      "Use this skill for organisation-scoped upload storage configuration and upload hook behavior.",
    configuration: `# Upload configuration

Configuration fields:

- \`provider\`: provider to configure: \`database\`, \`r2-binding\`, or \`r2\`.
- \`defaultProvider\`: default provider to use after configuration.
- \`r2\`: R2 provider credentials/configuration payload. Secret.
- \`r2Binding\`: R2 binding provider configuration payload.

Setup notes:

- \`database\` is the simplest provider when external object storage is not required.
- Use \`r2-binding\` when storage is provided by Worker bindings.
- Use \`r2\` when explicit R2 credentials/config are needed.
`,
    events: `# Upload events

No cataloged automation events.

Upload hook work is available under the \`upload\` hook scope.
`,
    tools: `# Upload tools

No dedicated runtime tools.

Use Backoffice connection tools for configuration/status and hook tools for queued hook inspection.
`,
  });
