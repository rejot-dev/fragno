import { skillFiles } from "@/fragno/backoffice-capabilities/backoffice-capabilities";

export const createResendCapabilityFiles = () =>
  skillFiles({
    name: "resend-connection",
    title: "Resend Connection",
    description:
      "Configure and automate the Backoffice Resend email capability. Use when setting up Resend delivery, inspecting email threads, replying to emails, or debugging Resend webhooks and durable hooks.",
    overview:
      "Use this skill for organisation-scoped Resend email delivery, email thread state, and reply automation.",
    configuration: `# Resend configuration

Configuration fields:

- \`apiKey\`: Resend API key. Secret; required on first setup.
- \`defaultFrom\`: default sender address; required on first setup.
- \`defaultReplyTo\`: optional reply-to address or list of addresses.
- \`webhookBaseUrl\`: public Backoffice origin or tunnel URL used for Resend webhooks.

Setup notes:

- Use a verified sender/domain for \`defaultFrom\`.
- The webhook base URL must be reachable by Resend.
`,
    events: `# Resend events

No cataloged automation events.

Resend maintains email thread state and hook work behind the \`resend\` hook scope.

The \`/resend\` filesystem also exposes email thread snapshots as Markdown files, one file per thread.
`,
    tools: `# Resend tools

Resend tools can:

- list email threads;
- load a thread with messages and a Markdown snapshot;
- send a plain-text reply to an existing thread.

Use codemode first. The \`resend\` provider exposes thread snapshot, thread listing, and reply functions. Use \`/resend\` when reading existing thread context as files is more convenient than calling provider functions.
`,
  });
