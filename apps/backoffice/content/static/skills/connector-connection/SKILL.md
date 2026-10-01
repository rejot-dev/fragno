---
name: connector-connection
description: >
  Connect Gmail and other OAuth providers through Backoffice Connector. Use when starting provider
  consent, checking connection requests, inspecting verified accounts, or executing Connector
  actions.
---

# Connector connection

Connector accounts are user-owned. The object host reads `OOMOL_CONNECTOR_BASE_URL` and
`OOMOL_PROJECT_API_KEY`; these are server configuration, not runtime-tool inputs. The key stays
outside agent files and tool arguments.

## Connect and verify

Select the owning user explicitly when the current execution is not already user-scoped:

```js
const connector = context.user(userId).connector;
```

1. Check project authentication with `await connector.check()`. A successful check does not
   establish Gmail account availability.
2. Start consent for the owning user:

   ```js
   const request = await connector.connect({ service: "gmail", connectionName: "work" });
   // Alternatively select one explicit providerConfigId instead of service.
   ```

3. Retain `request.id`, give `request.authorizationUrl` to the user, and wait for browser consent.
   The browser return opens a public landing page with next steps. It does not confirm consent or
   bind an account; callback status and account IDs are not proof.
4. Confirm the saved request with `await connector.refreshConnection({ requestId: request.id })`.
   Continue only when `state.status === "connected"`. `initiated` means consent is pending; `failed`
   and `expired` require a new connection request.
5. Perform a read-only identity check with
   `await connector.getProfile({ accountId: confirmed.state.connectedAccountId })`. Profile checks
   do not read Gmail messages or send mail.

Completion: a gateway-verified connected state and a successful provider profile check, not merely a
browser return or a locally listed account.

## Choose an account and action

`await connector.listAccounts({})` returns one page of this user's verified bindings. Continue with
`{ cursor: page.cursor }` while `page.hasNextPage` is true. These are local bindings, not a live
provider health report.

Use an explicit account for every action:

```js
await connector.executeAction({
  accountId: "verified-account-id",
  actionId: "gmail.search_threads",
  input: { query: "is:unread" },
});
```

Actions may modify external data. Obtain the user's instruction before writing or sending mail.
Action POSTs are not automatically retried; retain `executionId` when diagnosing an uncertain
result.

## Scope and permission boundaries

Use `context.user(userId).connector` for the owning user's connection. Organization and project
contexts cannot own Connector accounts. Each user has a separate ID-backed gateway identity and
database; sharing an account with an organization or project requires a future explicit delegation
model. The standalone CLI uses a different database and does not import its connections into
Backoffice.

Runtime tools require `connector.accounts.read`, `connector.connections.create`, or
`connector.actions.execute`. Use the current execution's explicit grants; a permission failure is
not a reason to switch principals or retry through another scope.

Bash command help and codemode method contracts are available in
`/static/terminal/terminal-spec.json` and `/static/codemode/providers/connector.d.ts`.
