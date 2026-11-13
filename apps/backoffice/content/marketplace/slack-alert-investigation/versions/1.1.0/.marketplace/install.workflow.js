/// <reference path="/static/codemode/workflow-authoring.d.ts" />

const SETTINGS_EVENT = "slack-alert-investigation.settings-configured";

/** @param {string} key @param {string} label @param {string} description @param {string} placeholder @param {boolean} required */
function textField(key, label, description, placeholder, required) {
  return {
    type: "TextInput",
    props: {
      label,
      value: { $bindState: "/response/" + key },
      description,
      placeholder,
      required,
    },
    children: [],
  };
}

/** @param {unknown} value */
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Whatever this workflow returns becomes the installation's settings. Installing the same version
// again runs it again, offering the current settings, which is how they are changed.
export default defineWorkflow(
  { name: "install-slack-alert-investigation" },
  async (/** @type {WorkflowEvent<any>} */ event, step) => {
    const current = await step.do("load current settings", async () => {
      const installation = await packages.get({ listingId: event.payload.listingId });
      const settings = installation?.settings ?? {};
      return {
        slackTeamId: trimmed(settings.slackTeamId),
        slackChannelId: trimmed(settings.slackChannelId),
        repository: trimmed(settings.repository),
        githubConnectionId: trimmed(settings.githubConnectionId),
        cloudflareAccountId: trimmed(settings.cloudflareAccountId),
      };
    });

    await step.do("request settings", async () => ({
      $ui: {
        version: 1,
        state: { response: current },
        spec: {
          root: "form",
          elements: {
            form: {
              type: "Stack",
              props: { gap: "md" },
              children: [
                "heading",
                "description",
                "slackTeamId",
                "slackChannelId",
                "repository",
                "githubConnectionId",
                "cloudflareAccountId",
                "submit",
              ],
            },
            heading: {
              type: "Heading",
              props: { text: "Configure Slack alert investigation", level: 3 },
              children: [],
            },
            description: {
              type: "Text",
              props: {
                text: "New messages in this Slack channel are investigated against this repository's main branch, and the report is posted in the message's thread. The channel's message events must already reach this workspace.",
                tone: "muted",
              },
              children: [],
            },
            slackTeamId: textField(
              "slackTeamId",
              "Slack workspace ID",
              "The ID of the Slack workspace the alert channel is in.",
              "T0123456789",
              true,
            ),
            slackChannelId: textField(
              "slackChannelId",
              "Slack channel ID",
              "The channel your alerts are posted in. Every new top-level message there is investigated.",
              "C0123456789",
              true,
            ),
            repository: textField(
              "repository",
              "GitHub repository",
              "The repository whose main branch is investigated, as owner/name.",
              "acme/app",
              true,
            ),
            githubConnectionId: textField(
              "githubConnectionId",
              "GitHub connection",
              "The connection that can read the repository.",
              "github#acme/app",
              true,
            ),
            cloudflareAccountId: textField(
              "cloudflareAccountId",
              "Cloudflare account ID (optional)",
              "Leave empty to investigate without Cloudflare. When set, alerts that name a Cloudflare Worker are checked against its telemetry through the mcp#cloudflare connection.",
              "32 hexadecimal characters",
              false,
            ),
            submit: {
              type: "WorkflowEventButton",
              props: {
                label: "Save settings",
                eventType: SETTINGS_EVENT,
                payload: { $state: "/response" },
                variant: "primary",
              },
              children: [],
            },
          },
        },
      },
    }));

    const configuration = await step.waitForEvent("wait for settings", { type: SETTINGS_EVENT });
    const submitted = /** @type {Record<string, unknown>} */ (configuration.payload ?? {});
    const settings = {
      slackTeamId: trimmed(submitted.slackTeamId),
      slackChannelId: trimmed(submitted.slackChannelId),
      repository: trimmed(submitted.repository),
      githubConnectionId: trimmed(submitted.githubConnectionId),
      cloudflareAccountId: trimmed(submitted.cloudflareAccountId) || null,
    };
    if (!/^T[A-Z0-9]+$/.test(settings.slackTeamId)) {
      throw new Error("Slack workspace ID must look like T0123456789.");
    }
    if (!/^[CG][A-Z0-9]+$/.test(settings.slackChannelId)) {
      throw new Error("Slack channel ID must look like C0123456789.");
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(settings.repository)) {
      throw new Error("GitHub repository must be written as owner/name.");
    }
    if (!settings.githubConnectionId) {
      throw new Error("GitHub connection is required.");
    }
    if (
      settings.cloudflareAccountId !== null &&
      !/^[a-f0-9]{32}$/.test(settings.cloudflareAccountId)
    ) {
      throw new Error("Cloudflare account ID must be 32 hexadecimal characters, or empty.");
    }
    return settings;
  },
);
