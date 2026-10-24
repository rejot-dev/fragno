# @fragno-dev/backoffice-api

## 0.1.0

### Minor Changes

- f5e13c6: feat!: attribute agent usage to its scope's root owner. Remove `billingOrganizationId`
  from Pi config and prompt inputs; read the manager agent's `provisioned` boolean instead of
  `provisioning`.

### Patch Changes

- 3393aa3: feat: add the `admin.users.manage` permission, which lets system administrators verify a
  user's email address.
- bd4b1e9: feat: page `api.connections.list` with a cursor, report mode-specific API auth status,
  and validate API connection slugs as the API fragment does.
- 5b2ef28: feat: remove the `api.*` connection, auth, and request operations and the `mcp.*` and
  `connector.*` operations; `integrations.*` replaces them. The `api.webhooks.*` operations remain.
- 7396bd5: feat: declare app actions with revisions, require `actionsRevision` for `apps.install`,
  add `apps.installations.approveActions`, give `BackofficeApp` a permanent `slug`
  (`appSlugSchema`), and add `v0/app-actions` to verify Backoffice's signed action requests.
- ba6e349: feat: add `branding` to first-party app trust, so Backoffice's sign-in speaks in the
  app's name.
- b7a76b2: feat!: add the app scope; projects may be owned by an organization, a user, or an app.
- 4236841: docs: state that `app:` event sources belong to installed apps.
- b9041e4: feat: add app `trust`, which marks apps Backoffice operates as first-party.
- 113b0e2: feat: export `isLoopbackUrl`; app action endpoints share the app URL rule and its "App
  URLs use HTTPS" message.
- 35df3ae: feat: add the `artifacts.pages.build` operation, which builds a workspace page as
  Backoffice does when it opens and reports the error viewers would see.
- 6e4b8d4: feat: `integrations.backfillConnectionEvents` records `disconnected` for connections
  whose integration was removed.
- 63d74f1: refactor!: rename the `js.build` result's `artifactPath` to `outputPath`; read
  `outputPath` instead.
- aaa872d: feat: accept workspace image evidence in `models.classify` with per-file read
  authorization and limits.
- 6ddde13: feat: add a typed v0 client and the scope path segment encoder.
- 3234651: feat: add the `conflict` error code and report missing resources as `not_found`.
- e43c3d9: feat: remove the `api`, `mcp`, and `connector` permissions; `api.webhooks.*` requires
  `connections.read` or `connections.manage`.
- f9656e5: feat: Connector connection and account records always carry a `connectionName`.
- cc13e62: feat: add the Backoffice API v0 contract with runtime-tool operations, an error envelope,
  and OpenAPI generation.
- 5c855bf: feat: `pi.agent.create` returns `resolvedModel`, the model the created agent runs, which
  names the preferred available model when its `model` is null.
- c9ffcf1: feat!: automation events record their `causation`: an origin, the route that derived
  them, or the workflow that fired them, linked to their parent and root events.
- 934eca9: feat: `events.get` returns the event's `routing`: `matching` until its routes are
  recorded, then each matched route's status (`pending`, `retrying`, `completed` with its outcome,
  or `failed`), failed attempts, and last error. The route outcome and state types are exported from
  `v0/events`.
- 5936409: feat: `events.list` returns each event's `routing`, as `events.get` does.
  `events.routes.list` lists the routes in one state, such as `failed` or `retrying`, each with the
  event it matched, newest match first.
- fa87f6e: feat: remove `github.repositories.list`, `github.repositories.create-access-token`, and
  the `github.read` permission; the `github` integration source replaces them.
- be5c0fd: feat: add `identity.external.list` to page through external identity bindings.
- f16c11b: feat!: app installations belong to an `owner`, an organization or a user, instead of an
  `organizationId`; the resource scope approving everything the owner has is now
  `{ kind: "owner" }`.
- bfb28ec: feat: integration connections report `authMethod`, one vocabulary for every source's auth
  configuration.
- 0a568be: docs: state that connection state changes arrive as `integrations` events keyed by
  `subject.connectionId`.
- e7bedb5: feat: add `integrations.backfillConnectionEvents`, which records each configured
  connection's current state as an `integrations.connection.*` event.
- 9287e40: feat: add `integrations.reconfigure` and `integrations.disconnect`.
- 4fb7788: feat: `integrations.get` returns the connection's stored `settings` that are not secret,
  so a reconfigure replacement can start from them.
- 4b0e65d: feat: report integration sources that fail to list in `integrations.list` as
  `unavailableSources` instead of failing the listing.
- 71f2263: feat: add `integrations.generateClient` to write a typed JavaScript client for a
  connection's actions.
- 551c2f1: feat: js.run and js.logs return log lines as { at, channel, text } instead of prefixed
  strings.
- 8985b9c: feat: add js.logs to read a codemode run's logs by run ID.
- a9c4bfc: feat: replace `js.logs` with `js.runs.list` and `js.runs.get`. `js.runs.get` returns one
  run with its outcome, console logs, and tool calls; use it where you called `js.logs`.
- 7e8de4b: feat: return runId from js.run and js.build, and report failures before a run as status
  rejected.
- b9cd25b: perf!: build contract schemas on first use. Module-level schemas are now `z.ZodLazy`; use
  `schema._zod.innerType` for `.extend`, `.shape`, `.pick`, and similar.
- a4cd3d9: feat: add marketplace.featured for listing a Marketplace's feature entries, report
  `featured` on Marketplace listings, and add the `marketplace.feature` permission.
- 741100b: feat: report mode-specific MCP auth status.
- 21315ba: feat: add the `models.classify` operation and the `models.classify` permission.
- a0c0cb4: feat: add the `models.generateImage` operation and the `models.generateImage` permission.
- 7e701f1: feat: add the `notify_agent` route action and `automationRouteActionAuthority`; scheduled
  agent notifications, like scheduled workflows, require organization-automation authority.
- 85a6aa2: feat: give OpenAPI operations summaries and the document a license, and drop redundant
  `anyOf`/`oneOf` compositions.
- 1ca945b: feat: add `backofficeApiOperationSummary`, the one-line summary OpenAPI also uses.
- c53b1f6: feat: add `visibility` to marketplace.search, marketplace.view and packages.install, and
  record each lock entry's Marketplace.
- 833c6b8: feat: require `visibility` on marketplace.publish to publish to the public or the owning
  organization's Marketplace.
- 9178cf7: feat: declare the permissions each v0 operation requires, also in the OpenAPI document.
- aca0d86: feat: add `pi.agent.backfillEvents`, which records a scope's defined agents as `pi`
  `agent.*` events where the events lack them.
- e767aff: feat: add `pi.agent.messages`, which reads an agent's latest messages without tool calls,
  and `pi.agent.export`, which writes its whole conversation to a workspace JSONL file.
- 63f141f: refactor: move `piAgentNameSchema` from `v0/pi` to `v0/shared/pi-agent-name`.
- 416ee52: feat!: a prompt receipt says whether the prompt steered the running turn or waits in the
  agent's queue, and no longer carries a Pi submission ID.
- 87ee9b4: feat!: rename the `pi.agent.abort` operation to `pi.agent.stop`, which returns
  `{ stopped: true }`; call `pi.agent.stop` instead.
- ac47ed7: feat: add streams to the API contract, the `pi.agent.watch` stream of an agent's live
  conversation, and `watch` in the client.
- c15e311: feat: replace Pi sessions with defined agents. `pi.session.*` operations become
  `pi.agent.list`, `pi.agent.get`, and `pi.agent.abort`; prompts and submissions address an
  `agentName`, `whenBusy` accepts `followUp`, and prompt receipts report the `whenBusy` that
  applied. `pi.agent.create`, `pi.agent.update`, and `pi.agent.delete` define agents and require
  `pi.manage`.
- 1f91afb: feat: add the pi.manage permission for defining Pi agents.
- 89f4b91: feat!: remove `pi.prompt.run` and `pi.submission.get`, and drop the conversation `view`
  from `pi.agent.get`'s output. Submit prompts with `pi.prompt.submit` and wait for the prompt's
  `pi` turn events instead.
- d9330e8: feat: add `isPrincipalOnlyPermission` for the permissions apps never hold.
- 6cf853e: feat!: project scopes name their owner as a scope
  (`{ kind: "project", owner: { kind: "org", orgId }, projectId }`), and project segments embed the
  owner's segment (`project:org:<orgId>:<projectId>`).
- 5e469b1: feat: add the `invitations.create` provisioning operation, so a first-party app invites
  people as a member who authorized it.
- 38d0b8a: feat: add the `v0/provisioning` contract and `createBackofficeProvisioningClient` for
  first-party apps.
- 1edcf13: feat!: remove the `connections.*` operations and their schemas; configure services
  through `integrations.*`. Upload storage moves to `upload.storage.get` and
  `upload.storage.configure`.
- 80342a2: feat: export the Resend thread summary, detail, and message schemas.
- 4420fc7: feat: add the `reson8.realtime.token` operation, which mints a short-lived token for
  streaming audio to Reson8 directly.
- a8db51f: feat: add the `reson8.transcribe` permission and the `reson8.prerecorded.transcribe`
  operation, which transcribes an audio file from the workspace by path.
- 85fcbc5: feat: `events.routes.retry` runs a route that failed for good on a stored event again,
  with a fresh set of attempts, and returns the route as pending.
- 6573774: feat: add sandbox image and size selection with resumable workspaces.
- 62500ac: feat: make `BackofficeScope` generic over how a scope names its organization and project,
  and share one codec for scope path segments and route parameters.
- 65705da: feat: add `backofficeScopeProjectOwner`, the scope whose projects sit beside a workspace.
- b254c6c: feat: add scope parsing, comparison, and parse errors to v0/shared/scope, with strict
  scope schemas.
- 9766eb4: feat!: `state.searchFiles` takes `keywords` (1–8 strings, matching any) instead of
  `query`; pass `keywords: [query]` to migrate.
- 169c08d: feat: remove the `telegram.*` and `resend.*` operations and the `telegram`, `resend`, and
  `reson8` permissions; the `backoffice#telegram` and `backoffice#resend` integrations replace them.
  `hooks.get` explains where an ingested event's payload sits.
- bca40c1: feat: publish each integration action's `validation` and run unchecked actions with
  `integrations.execute`'s `unchecked: true`.
- ac09cc7: feat: Add `upload.createDownloadLink` and `upload.createUploadLink`, which return
  temporary URLs that sandbox commands use to read or write workspace files.
- 4dbcbde: feat: remove the `api.webhooks.*` operations; inbound webhooks are set up as
  `webhook#<endpointId>` integrations. `secretFields` names nested secrets as dot-separated paths.
- ede5ff8: feat: add `backofficeWorkspaceOrganization`, the organization whose own workspace a scope
  is.
- aab1688: fix: remove `followUp` from Pi prompt `whenBusy`; busy sessions take prompts as steering
  input.
- 4c3ba00: feat: Add scoped project creation and cursor-paginated listing APIs.
- f5a9356: feat: add the `organizations.provisionForInvitee` provisioning operation, which creates
  an organization with a pending owner invitation for someone who need not have signed in yet
