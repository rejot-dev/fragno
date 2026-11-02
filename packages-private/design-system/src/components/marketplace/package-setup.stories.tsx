import { PackageSetup, type PackageSetupRoute } from "./package-setup";

export default { title: "Marketplace/Package setup" };

const telegramTurnRoute = (eventType: string): PackageSetupRoute => ({
  id: `telegram-pi-${eventType.replace(".", "-")}`,
  name: `Resume Telegram Pi workflow on ${eventType}`,
  enabled: true,
  trigger: {
    kind: "event",
    source: "pi",
    eventType,
    condition:
      'subject.agentName equals "telegram" and subject.requestId starts with "telegram-pi-"',
  },
  action: { label: "Send pi-turn-settled to workflow", target: "${event.subject.requestId}" },
  runsAs: null,
});

export function TelegramChannel() {
  return (
    <div className="max-w-3xl">
      <PackageSetup
        permissions={["identity.resolve", "integrations.execute", "otp.create", "store.modify"]}
        agents={[
          {
            name: "telegram",
            description: "Answers messages from Telegram chats linked to Backoffice users.",
            model: null,
            permissions: ["*"],
            instructions:
              "Messages arrive from Telegram chats linked to Backoffice users. Each one starts with the chat\nit came from, such as `[Telegram chat 1001]`, and runs with the permissions of that chat's\nlinked user.\n\nIMPORTANT: your final answer to each message is AUTOMATICALLY sent back to its chat in Telegram\nMarkdown parse mode. Keep it short, and do not repeat the chat prefix.",
          },
        ]}
        routes={[
          {
            id: "telegram-start-linking",
            name: "Telegram /start identity linking",
            enabled: true,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              condition: 'payload.text equals "/start"',
            },
            action: {
              label: "Start workflow",
              target: "automations/telegram-user-linking.workflow.js",
            },
            runsAs: {
              actor: "Organization-owned automation",
              grants: ["identity.resolve", "integrations.execute", "otp.create", "store.modify"],
            },
          },
          {
            id: "telegram-identity-claim-completed",
            name: "Forward Telegram identity claim completion",
            enabled: true,
            trigger: {
              kind: "event",
              source: "otp",
              eventType: "identity.claim.completed",
              condition: "the initiator is an external telegram actor",
            },
            action: {
              label: "Send identity-claim-completed to the workflow stored at",
              target: "telegram/claim-workflow/${event.payload.otpId}",
            },
            runsAs: null,
          },
          {
            id: "telegram-pi-linking",
            name: "Telegram Pi agent messages",
            enabled: true,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              condition:
                'payload.text equals "/pi" or (payload.text exists and not payload.text starts with "/")',
            },
            action: {
              label: "Start workflow",
              target: "automations/telegram-user-pi-linking.workflow.js",
            },
            runsAs: { actor: "Backoffice user linked to the incoming sender", grants: "inherit" },
          },
          telegramTurnRoute("turn.completed"),
          telegramTurnRoute("turn.failed"),
          telegramTurnRoute("turn.aborted"),
          telegramTurnRoute("queue.dropped"),
        ]}
        eventTypes={[]}
      />
    </div>
  );
}

const githubPayloadFields = ["deliveryId", "installationId", "repository", "sender"];

export function GitHubChannel() {
  return (
    <div className="max-w-3xl">
      <PackageSetup
        permissions={[]}
        agents={[]}
        routes={[
          {
            id: "github-issues-opened-reclassify",
            name: "Classify opened GitHub issues",
            enabled: true,
            trigger: {
              kind: "event",
              source: "github",
              eventType: "webhook.received",
              condition: 'payload.githubEvent equals "issues" and payload.action equals "opened"',
            },
            action: { label: "Reclassify as", target: "github · issues.opened" },
            runsAs: null,
          },
          {
            id: "github-push-reclassify",
            name: "Classify GitHub pushes",
            enabled: false,
            trigger: {
              kind: "event",
              source: "github",
              eventType: "webhook.received",
              condition: 'payload.githubEvent equals "push"',
            },
            action: { label: "Reclassify as", target: "github · push" },
            runsAs: null,
          },
        ]}
        eventTypes={[
          {
            source: "github",
            eventType: "issues.opened",
            label: "GitHub issue opened",
            description: "Fires when GitHub reports that an issue was opened.",
            payloadFields: [...githubPayloadFields, "issue"],
          },
          {
            source: "github",
            eventType: "push",
            label: "GitHub push",
            description: null,
            payloadFields: [],
          },
        ]}
      />
    </div>
  );
}

export function ScheduledReport() {
  return (
    <div className="max-w-3xl">
      <PackageSetup
        permissions={["integrations.execute", "pi.modify"]}
        agents={[
          {
            name: "reporter",
            description: "Writes the daily operations report.",
            model: "anthropic/claude-sonnet-5-5",
            permissions: ["files.read", "integrations.execute"],
            instructions: "",
          },
        ]}
        routes={[
          {
            id: "daily-report",
            name: "Daily report",
            enabled: true,
            trigger: { kind: "schedule", cadence: "On cron 0 8 * * *, UTC" },
            action: { label: "Start workflow", target: "automations/daily-report.workflow.js" },
            runsAs: { actor: "Organization-owned automation", grants: [] },
          },
        ]}
        eventTypes={[]}
      />
    </div>
  );
}

export function NothingToSetUp() {
  return (
    <div className="max-w-3xl">
      <PackageSetup permissions={[]} agents={[]} routes={[]} eventTypes={[]} />
    </div>
  );
}
