---
name: open-connector-connection
description: >
  Create Open Connector connections for long-tail services without a native Backoffice integration,
  such as a request to connect Linear or Gmail. Default to this skill unless the user requests a
  low-level API/MCP connection. Use for provider-config discovery, consent, verified user accounts,
  and provider actions.
---

# Open Connector Connections

Read `/static/codemode/providers/connector.d.ts` before executing Open Connector calls. This skill
connects external provider accounts through the Open Connector gateway. These connections are
separate from native integrations and low-level API/MCP connections.

Open Connector connections are user-owned. The object host reads `OOMOL_CONNECTOR_BASE_URL` and
`OOMOL_PROJECT_API_KEY`; these are server configuration, not runtime-tool inputs. The key stays
outside agent files and tool arguments.

## Connect and verify

Select the owning user explicitly when the current execution is not already user-scoped:

```js
const connector = context.user(userId).connector;
```

1. Discover this project's available OAuth configurations with
   `await connector.listProviderConfigs()`. Select the requested service from `providerConfigs`;
   each overview includes its `id`, `displayName`, `effectiveScopes`, and `proxyAvailable`. This is
   project configuration, not proof of a connected or healthy user account. **Complete when** one
   configuration is selected. If several fit, use the user's explicit choice or collect the missing
   choice; if none fit or discovery fails, report the observed blocker.
2. Start consent for the selected configuration and owning user:

   ```js
   const request = await connector.connect({
     providerConfigId: selectedConfig.id,
     connectionName: "work",
   });
   ```

   **Complete when** the gateway returns the selected provider's saved connection request.

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
provider health report. Retrieve action IDs separately with
`await connector.listProviderActions({ providerConfigId: account.providerConfigId })`; select from
its `actionIds` rather than assuming every configuration of a service supports the same actions.

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
contexts cannot own Open Connector connections. Each user has a separate ID-backed gateway identity
and database; sharing an account with an organization or project requires a future explicit
delegation model. The standalone CLI uses a different database and does not import its connections
into Backoffice.

Discovery requires `connector.providers.read`; account reads require `connector.accounts.read`,
OAuth requires `connector.connections.create`, and actions require `connector.actions.execute`. Use
the current execution's explicit grants; a permission failure is not a reason to switch principals
or retry through another scope.

In Bash, `connector.providers.list` prints a readable overview;
`connector.providers.actions --provider-config-id ID` prints that configuration's action IDs. Both
support `--format json` and `--print`. For command help, read `/static/terminal/terminal-spec.json`.
