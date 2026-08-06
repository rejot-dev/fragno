# Plan: Marketplace installation workflows

## Shape

The installation workflow is an optional conventional artifact file:

```ts
{
  version: "1.2.1",
  files: {
    "automations/telegram-test-command.workflow.js": workflowSource,
    ".marketplace/install.workflow.js": `defineWorkflow(
      { name: "install-telegram-test-command" },
      async (event, step) => {
        const workflowScriptPath =
          event.payload.installedFiles["automations/telegram-test-command.workflow.js"];

        await step.do("ensure Telegram /test route", async () => {
          const route = await router.get({ id: "telegram-test-command" });
          if (route) {
            if (route.metadata?.managedBy?.listingId !== event.payload.listingId) {
              throw new Error("The route is not managed by this Marketplace listing.");
            }
            return route;
          }

          return await router.create({
            id: "telegram-test-command",
            name: "Telegram /test command",
            enabled: true,
            trigger: {
              kind: "event",
              source: "telegram",
              eventType: "message.received",
              matcher: { path: "$.payload.text", op: "eq", value: "/test" },
            },
            priority: 110,
            action: {
              kind: "start_workflow",
              remoteWorkflowName: "telegram-test-command",
              workflowScriptPath,
              instanceIdTemplate: "telegram-test-\${event.id}",
            },
          });
        });
      },
    )`,
  },
}
```

Ingestion detects `.marketplace/install.workflow.js` by convention and does not copy `.marketplace/`
into the destination workspace. No manifest or Marketplace database field is required.

## Workflow input

```ts
type MarketplaceInstallationWorkflowInput = {
  listingId: string;
  version: string;
  previousVersion: string | null;
  targetScope: BackofficeRoutableScope;
  installationRoot: "/workspace";
  installedFiles: Record<string, string>;
  previousInstalledFiles: Record<string, string>;
};
```

`installedFiles` maps artifact-relative paths to their resolved destination paths. Installation
workflows must use this map instead of hard-coding `/workspace`.

## Ingestion flow

1. Load and verify the Marketplace artifact.
2. Separate `.marketplace/install.workflow.js` from installable files.
3. Copy and verify installable files.
4. Execute the installation workflow in the selected target scope.
5. Record `marketplace_ingestion.version` after it completes.

Run it beneath a stable `run marketplace installation workflow` step using the existing codemode
workflow executor and `getRemoteWorkflowStepHost(step)`. Its steps, retries, sleeps, and waits
become children of the `marketplace-ingest` workflow.

## Runtime changes

- Extract reusable target-scoped workflow execution from
  `apps/backoffice/app/fragno/automation/engine/automation-codemode-workflow.ts`.
- Pass `env`, `kernel`, and `getAutomationFileSystem` to `defineMarketplaceIngestWorkflow`.
- Execute with normal target-scoped runtime tools such as `router`.
- Do not add a JSON installation language or a child workflow instance protocol.

## Telegram migration

- Add the `/test` installation workflow to the Marketplace item.
- Remove `telegram-test-command` from `STARTER_AUTOMATION_ROUTES`.
- Let the installer accept the unchanged legacy route and reject incompatible local changes.

## Tests

- installer is published at the reserved path and not copied;
- installed file paths match the selected scope and destination;
- installer tools target organization, project, and user scopes correctly;
- installer steps replay and resume inside `marketplace-ingest`;
- failure does not advance `marketplace_ingestion.version`;
- Telegram installation creates the route with the resolved script path;
- versions without an installer remain file-only installs.
