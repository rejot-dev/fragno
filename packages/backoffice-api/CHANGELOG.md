# @fragno-dev/backoffice-api

## 0.0.1

### Patch Changes

- bd4b1e9: feat: page `api.connections.list` with a cursor, report mode-specific API auth status, and validate
  API connection slugs as the API fragment does.
- 5b2ef28: feat: remove the `api.*` connection, auth, and request operations and the `mcp.*` and `connector.*`
  operations; `integrations.*` replaces them. The `api.webhooks.*` operations remain.
- 7396bd5: feat: declare app actions with revisions, require `actionsRevision` for `apps.install`, add
  `apps.installations.approveActions`, give `BackofficeApp` a permanent `slug` (`appSlugSchema`), and
  add `v0/app-actions` to verify Backoffice's signed action requests.
- b7a76b2: feat!: add the app scope; projects may be owned by an organization, a user, or an app.
- 4236841: docs: state that `app:` event sources belong to installed apps.
- 6ddde13: feat: add a typed v0 client and the scope path segment encoder.
- 3234651: feat: add the `conflict` error code and report missing resources as `not_found`.
- e43c3d9: feat: remove the `api`, `mcp`, and `connector` permissions; `api.webhooks.*` requires
  `connections.read` or `connections.manage`.
- f9656e5: feat: Connector connection and account records always carry a `connectionName`.
- cc13e62: feat: add the Backoffice API v0 contract with runtime-tool operations, an error envelope, and
  OpenAPI generation.
- fa87f6e: feat: remove `github.repositories.list`, `github.repositories.create-access-token`, and the
  `github.read` permission; the `github` integration source replaces them.
- be5c0fd: feat: add `identity.external.list` to page through external identity bindings.
- f16c11b: feat!: app installations belong to an `owner`, an organization or a user, instead of an
  `organizationId`; the resource scope approving everything the owner has is now `{ kind: "owner" }`.
- bfb28ec: feat: integration connections report `authMethod`, one vocabulary for every source's auth
  configuration.
- 0a568be: docs: state that connection state changes arrive as `integrations` events keyed by
  `subject.connectionId`.
- e7bedb5: feat: add `integrations.backfillConnectionEvents`, which records each configured connection's
  current state as an `integrations.connection.*` event.
- 9287e40: feat: add `integrations.reconfigure` and `integrations.disconnect`.
- 4fb7788: feat: `integrations.get` returns the connection's stored `settings` that are not secret, so a
  reconfigure replacement can start from them.
- 4b0e65d: feat: report integration sources that fail to list in `integrations.list` as `unavailableSources`
  instead of failing the listing.
- 71f2263: feat: add `integrations.generateClient` to write a typed JavaScript client for a connection's
  actions.
- 551c2f1: feat: js.run and js.logs return log lines as { at, channel, text } instead of prefixed strings.
- 8985b9c: feat: add js.logs to read a codemode run's logs by run ID.
- 7e8de4b: feat: return runId from js.run and js.build, and report failures before a run as status rejected.
- b9cd25b: perf!: build contract schemas on first use. Module-level schemas are now `z.ZodLazy`; use
  `schema._zod.innerType` for `.extend`, `.shape`, `.pick`, and similar.
- a4cd3d9: feat: add marketplace.featured for listing a Marketplace's feature entries, report `featured` on
  Marketplace listings, and add the `marketplace.feature` permission.
- 741100b: feat: report mode-specific MCP auth status.
- 85a6aa2: feat: give OpenAPI operations summaries and the document a license, and drop redundant
  `anyOf`/`oneOf` compositions.
- 1ca945b: feat: add `backofficeApiOperationSummary`, the one-line summary OpenAPI also uses.
- c53b1f6: feat: add `visibility` to marketplace.search, marketplace.view and packages.install, and record each
  lock entry's Marketplace.
- 833c6b8: feat: require `visibility` on marketplace.publish to publish to the public or the owning
  organization's Marketplace.
- 9178cf7: feat: declare the permissions each v0 operation requires, also in the OpenAPI document.
- c15e311: feat: replace Pi sessions with defined agents. `pi.session.*` operations become `pi.agent.list`,
  `pi.agent.get`, and `pi.agent.abort`; prompts and submissions address an `agentName`, `whenBusy`
  accepts `followUp`, and prompt receipts report the `whenBusy` that applied. `pi.agent.create`,
  `pi.agent.update`, and `pi.agent.delete` define agents and require `pi.manage`.
- 1f91afb: feat: add the pi.manage permission for defining Pi agents.
- 6cf853e: feat!: project scopes name their owner as a scope
  (`{ kind: "project", owner: { kind: "org", orgId }, projectId }`), and project segments embed the
  owner's segment (`project:org:<orgId>:<projectId>`).
- 1edcf13: feat!: remove the `connections.*` operations and their schemas; configure services through
  `integrations.*`. Upload storage moves to `upload.storage.get` and `upload.storage.configure`.
- 80342a2: feat: export the Resend thread summary, detail, and message schemas.
- 6573774: feat: add sandbox image and size selection with resumable workspaces.
- 62500ac: feat: make `BackofficeScope` generic over how a scope names its organization and project, and share
  one codec for scope path segments and route parameters.
- 65705da: feat: add `backofficeScopeProjectOwner`, the scope whose projects sit beside a workspace.
- b254c6c: feat: add scope parsing, comparison, and parse errors to v0/shared/scope, with strict scope schemas.
- 169c08d: feat: remove the `telegram.*` and `resend.*` operations and the `telegram`, `resend`, and `reson8`
  permissions; the `backoffice#telegram` and `backoffice#resend` integrations replace them.
  `hooks.get` explains where an ingested event's payload sits.
- bca40c1: feat: publish each integration action's `validation` and run unchecked actions with
  `integrations.execute`'s `unchecked: true`.
- 4dbcbde: feat: remove the `api.webhooks.*` operations; inbound webhooks are set up as `webhook#<endpointId>`
  integrations. `secretFields` names nested secrets as dot-separated paths.
- ede5ff8: feat: add `backofficeWorkspaceOrganization`, the organization whose own workspace a scope is.
- aab1688: fix: remove `followUp` from Pi prompt `whenBusy`; busy sessions take prompts as steering input.
