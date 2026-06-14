# Backoffice Automation Scenarios

Use `scenario.ts` for Backoffice automation tests that should read as product flows instead of
Durable Object, route, and codemode plumbing.

## Shape

```ts
await runBackofficeScenario(
  defineBackofficeScenario({
    name: "starter telegram /start links a chat through OTP",
    files: backofficeFiles.workspaceStarter(),
    fakes: ({ fake }) => ({
      telegram: fake.telegram(),
    }),
    setup: ({ given }) => [
      given.organization.exists({ id: "org-1", name: "Ada Labs" }),
      given.telegram.configured({
        orgId: "org-1",
        botUsername: "fragno_bot",
      }),
    ],
    steps: ({ when, then }) => [
      when.telegram.receivesMessage({
        orgId: "org-1",
        updateId: 1,
        chatId: "1001",
        text: "/start",
      }),
      then.telegram.sentMessage({
        chatId: "1001",
        text: /Open this link to finish linking your Telegram account/u,
        captureUrlAs: "claimUrl",
      }),
      then.workflow.instance({
        remoteWorkflowName: "telegram-user-linking",
        status: "waiting",
        waitingFor: "identity-claim-completed",
      }),
      when.otp.confirmClaimFromCapturedUrl({
        url: "claimUrl",
        subjectUserId: "user-1",
      }),
      then.store.entry({
        orgId: "org-1",
        key: "telegram/1001",
        value: "user-1",
      }),
    ],
  }),
);
```

`setup` is for arrangement. `steps` is the behavior under test. Failures include the scenario
journal, store entries, workflow instances and history, hook queues, filesystem paths and scenario
file diffs, codemode runs, and fake service calls.

The runner appends final `then.workflow.noErrored()` and `then.hooks.noFailed()` assertions by
default. Use `options: { allowErroredWorkflows: true }` or
`options: { allowFailedDurableHooks: true }` only for scenarios that intentionally assert those
failure states.

## Files

Use the preset that matches the behavior under test:

- `backofficeFiles.systemOnly()` for system automation routing and workspace initialization.
- `backofficeFiles.workspaceStarter()` for starter workspace automations.
- `backofficeFiles.fullStarter()` when a scenario needs both system and starter content.
- `backofficeFiles.custom({ system, workspace })` for small custom automation fixtures.

Use `given.files({ orgId, files })` for direct multi-file setup. Use `given.codemode.writeFile(...)`
when the test should prove codemode tools can write files.

File assertions read the scenario filesystem first and then the real Backoffice org filesystem, so
they work for both injected automation files and upload-backed workspace files:

```ts
then.files.contains({
  orgId: "org-1",
  path: "/workspace/codemode.d.ts",
  text: "declare const telegram",
});

then.files.diff({
  orgId: "org-1",
  include: [{ path: "/workspace/output.txt", status: "added" }],
});
```

## Codemode

`when.codemode.run(...)` uses the real `runBackofficeCodemode(...)` path with route-backed runtime
tools. Prefer semantic setup helpers unless the scenario is specifically proving codemode wiring:

- `given.codemode.run(...)`
- `given.codemode.storeSet(...)`
- `given.codemode.connectionConfigure(...)`
- `given.codemode.writeFile(...)`
- `given.direct.storeEntry(...)`
- `given.direct.file(...)`

Assert tool usage with `then.codemode.toolCalls({ include: [...] })`.

## Workflows, Hooks, And Time

Most automation workflows run as `automation-codemode-script`; use `remoteWorkflowName` for the
domain workflow name:

```ts
then.workflow.instance({
  remoteWorkflowName: "telegram-test-command",
  status: "waiting",
});

when.time.advance("3 seconds");

then.workflow.event({
  remoteWorkflowName: "telegram-user-linking",
  type: "identity-claim-completed",
  consumedByStepKey: "waitForEvent:identity-claim-completed",
});
```

Prefer `when.automation.ingestEvent(...)`, `when.telegram.receivesMessage(...)`, and
`when.otp.confirmClaim...(...)` for product flows. Use direct workflow steps for workflow-local edge
cases where the router would filter or reshape the event:

```ts
when.workflow.createInstance({
  orgId: "org-1",
  remoteWorkflowName: "telegram-user-linking",
  instanceId: "telegram-link-edge",
  params: {
    automationEvent,
    workflowInstanceId: "telegram-link-edge",
    workflowScriptPath: "/workspace/automations/telegram-user-linking.workflow.js",
  },
});

when.workflow.sendEvent({
  orgId: "org-1",
  instanceId: "telegram-link-edge",
  type: "identity-claim-completed",
  payload: claimCompletedEvent,
});
```

Use `then.hooks.noPending({ orgId, fragments })` for fragments that should be fully drained. Do not
use it for expected future hooks such as OTP expiry timers unless the scenario advances time or
otherwise drains them.

## Fakes

Configured fakes replace the corresponding in-memory object implementation:

- `fake.telegram()` records messages, edits, chat actions, and webhook setup.
- `when.telegram.webhook(...)` posts a raw Telegram update. `when.telegram.receivesMessage(...)` is
  the message-shaped convenience wrapper.
- `fake.pi()` records session creation, session lookups, and turns. It can return custom assistant
  text and supports `setSessionStatus(...)` for terminal-session scenarios.
- `fake.resend({ threads })` seeds route-backed Resend threads/messages and records `replyToThread`
  calls. Assert replies with `then.resend.repliedToThread(...)`.

## Verification

Focused runner verification:

```sh
pnpm --filter @fragno-apps/backoffice-rr types:check
cd apps/backoffice && pnpm exec vitest run \
  app/fragno/automation/starter-otp-linking.test.ts \
  app/fragno/automation/scenario-system-automations.test.ts \
  app/fragno/automation/scenario-codemode.test.ts \
  app/fragno/automation/scenario-starter-router.test.ts
pnpm run lint:fix
pnpm run format:changed
```
