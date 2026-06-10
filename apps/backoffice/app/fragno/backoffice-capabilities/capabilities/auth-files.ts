import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createAuthCapabilityFiles = () =>
  skillFiles({
    name: "auth-system",
    title: "Auth System",
    description:
      "Work with the Backoffice Auth system capability. Use when debugging auth durable hooks, authenticated user flows, or automations that depend on Backoffice user identity.",
    overview:
      "Use this skill for Auth system hook behavior and identity-aware automation behavior.",
    configuration: `# Auth configuration

Auth is a system capability.
`,
    events: `# Auth events

No cataloged automation events.

Auth hook work is available under the \`auth\` hook scope.
`,
    tools: `# Auth tools

No dedicated runtime tools.

Use hook tools for queued hook inspection.
`,
  });
