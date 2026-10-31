# @fragno-dev/backoffice-api

## 0.1.0

### Minor Changes

- f5e13c6: feat!: attribute agent usage to its scope's root owner. Remove `billingOrganizationId`
  from Pi config and prompt inputs; read the manager agent's `provisioned` boolean instead of
  `provisioning`.

### Patch Changes

- 118bb3e: feat: replace the `admin.signUpInvitationsManage` permission
  (`sign-up-invitations.manage`) with `admin.accessCodesManage` (`access-codes.manage`). To migrate,
  reference `BACKOFFICE_PERMISSION.admin.accessCodesManage` instead.
- 3393aa3: feat: add the `admin.users.manage` permission, which lets system administrators verify a
  user's email address.
- 2230e86: feat!: Pi agent definitions report their `steward` (`members`, `package`, or `backoffice`
  for built-in agents) instead of `managedBy`, packages declare agents in
  `.marketplace/installation.json` as `agents`, and `packages.uninstall` returns `removedAgents`.
  Read `steward` where you read `managedBy`, and declare a package's agents instead of passing
  `managedBy` to `pi.agent.create` or `pi.agent.update`, which now refuse it.
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
- 116a5b3: feat: add the `blobs.*` operations for large files kept outside the workspace.
  `blobs.createUpload` returns a presigned URL that accepts one PUT of the bytes, straight to
  storage, without knowing their size; `blobs.completeUpload` records the stored size and ETag and
  publishes the blob. `blobs.get`, `blobs.list`, `blobs.createDownloadUrl`, and `blobs.delete` read,
  share, and remove a scope's blobs. `blobs.read` returns up to 1 MiB of a blob from an offset, so
  agents can look inside large files, such as a zip archive's directory, without downloading them.
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
- 465d519: feat: event definitions report their `steward`, and packages declare them in
  `.marketplace/installation.json` as `eventDefinitions`; `packages.uninstall` also returns
  `removedEventDefinitions`. The route steward type `AutomationRouteSteward` is now
  `AutomationSteward`.
- 934eca9: feat: `events.get` returns the event's `routing`: `matching` until its routes are
  recorded, then each matched route's status (`pending`, `retrying`, `completed` with its outcome,
  or `failed`), failed attempts, and last error. The route outcome and state types are exported from
  `v0/events`.
- 8e26fe5: feat: automation event subjects name the scope they are about in full as `subject.scope`,
  which replaces `subject.orgId`, and `forward_event` can target `{ kind: "subject" }` to deliver an
  event to that scope. Read `subject.scope.orgId` where you read `subject.orgId`, and match
  `$.subject.scope.kind` instead of `$.subject.orgId`.
- 5936409: feat: `events.list` returns each event's `routing`, as `events.get` does.
  `events.routes.list` lists the routes in one state, such as `failed` or `retrying`, each with the
  event it matched, newest match first.
- 0795d97: feat: `state.share`, `state.acceptShare`, `state.listShares`, and `state.revokeShare`
  share a `/workspace` folder with another scope without copying it: once accepted, that scope reads
  it at `/shared/<name>/`, under a name it chooses, until either side revokes it.
  `state.searchFiles` returns a `shared` page when its pattern names a share, and `models.extract`
  and `models.classify` read files under `/shared`.
- fa87f6e: feat: remove `github.repositories.list`, `github.repositories.create-access-token`, and
  the `github.read` permission; the `github` integration source replaces them.
- be5c0fd: feat: add `identity.external.list` to page through external identity bindings.
- ca1b553: feat: `packages.importLegacy` imports installations from the legacy
  `marketplace-lock.json` and deletes it. Installing into a workspace that still has the file is
  refused until it is imported.
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
- 217130e: fix: `packages.importLegacy` keeps a `marketplace-lock.json` that changes while
  importing, reporting `lock: "changed"`, instead of deleting entries it never imported. Import
  again to pick them up.
- f95a624: feat: provisioning adds `organizations.provisionManaged` and `organizations.listManaged`,
  and `projects.provision` and `invitations.create` accept users acting through the managing
  organization. `org.get` answers `managingOrganization` and `through`.
- a4cd3d9: feat: add marketplace.featured for listing a Marketplace's feature entries, report
  `featured` on Marketplace listings, and add the `marketplace.feature` permission.
- 741100b: feat: report mode-specific MCP auth status.
- 6975d9a: feat: let `models.classify` and `models.extract` read blobs. Their `images` and `files`
  now name each file as `{ path }` for a workspace file or `{ blob }` for a blob key, instead of a
  path string.
- 21315ba: feat: add the `models.classify` operation and the `models.classify` permission.
- 9c0eb63: feat: add `models.extract`, which reads workspace PDFs and images into an answer that
  matches a JSON Schema with a chosen `model` (`MODELS_EXTRACT_MODELS`) and `thinkingLevel`, behind
  the new `models.extract` permission.
- a0c0cb4: feat: add the `models.generateImage` operation and the `models.generateImage` permission.
- 3f46999: feat: add the `models.run` permission, which running a hosted model such as a Workers AI
  model requires.
- 9d1d002: feat: `integrations.setup` input may move setup to another address of the same source,
  such as a new connection name; the progress names the address it describes.
- 7e701f1: feat: add the `notify_agent` route action and `automationRouteActionAuthority`; scheduled
  agent notifications, like scheduled workflows, require organization-automation authority.
- 85a6aa2: feat: give OpenAPI operations summaries and the document a license, and drop redundant
  `anyOf`/`oneOf` compositions.
- 1ca945b: feat: add `backofficeApiOperationSummary`, the one-line summary OpenAPI also uses.
- c53b1f6: feat: add `visibility` to marketplace.search, marketplace.view and packages.install, and
  record each lock entry's Marketplace.
- 833c6b8: feat: require `visibility` on marketplace.publish to publish to the public or the owning
  organization's Marketplace.
- 9464377: feat: routes report their `steward`, `members` or the package that manages them, instead
  of a `managedBy` label callers set; `router.create` and `router.update` no longer accept
  `managedBy`, so packages declare their routes in `.marketplace/installation.json` instead. Package
  installs approve the release's declared `permissions`. `packages.ls` lists installation records
  with their settings, and `packages.get` and `packages.uninstall` are new. Pi agents' `managedBy`
  is now typed `PiAgentMarketplaceManagedBy`.
- 9178cf7: feat: declare the permissions each v0 operation requires, also in the OpenAPI document.
- aca0d86: feat: add `pi.agent.backfillEvents`, which records a scope's defined agents as `pi`
  `agent.*` events where the events lack them.
- 18d8170: feat!: `pi.agent.messages` reads from an agent's newest compaction or clear on, as the
  chat does, with compaction summaries as `compaction` messages; `pi.agent.export` does the same
  unless passed `history`. Read a prompt's answer with `pi.prompt.get` instead of paging messages to
  its entry.
- e767aff: feat: add `pi.agent.messages`, which reads an agent's latest messages without tool calls,
  and `pi.agent.export`, which writes its whole conversation to a workspace JSONL file.
- 63f141f: refactor: move `piAgentNameSchema` from `v0/pi` to `v0/shared/pi-agent-name`.
- 416ee52: feat!: a prompt receipt says whether the prompt steered the running turn or waits in the
  agent's queue, and no longer carries a Pi submission ID.
- 87ee9b4: feat!: rename the `pi.agent.abort` operation to `pi.agent.stop`, which returns
  `{ stopped: true }`; call `pi.agent.stop` instead.
- ac47ed7: feat: add `PiAgentWatchFrame`, `PiAgentQueueEntry`, and `PI_AGENT_WATCH_REFUSED` for
  `pi.agent.watch`, a WebSocket that follows an agent's conversation and queue live.
- c15e311: feat: replace Pi sessions with defined agents. `pi.session.*` operations become
  `pi.agent.list`, `pi.agent.get`, and `pi.agent.abort`; prompts and submissions address an
  `agentName`, `whenBusy` accepts `followUp`, and prompt receipts report the `whenBusy` that
  applied. `pi.agent.create`, `pi.agent.update`, and `pi.agent.delete` define agents and require
  `pi.manage`.
- 1f91afb: feat: add the pi.manage permission for defining Pi agents.
- fee8c85: feat: a completed `pi.prompt.get` status carries the prompt's `answer`, readable however
  the agent's context changes later; read answers with it rather than through `turn.completed`'s
  `answerEntryId`.
- 89f4b91: feat!: remove `pi.prompt.run` and `pi.submission.get`, and drop the conversation `view`
  from `pi.agent.get`'s output. Submit prompts with `pi.prompt.submit` and wait for the prompt's
  `pi` turn events instead.
- a8e23eb: feat: `pi.prompt.get` tells where a prompt submitted with a request ID stands: queued,
  running, completed, or failed with the reason it will not be answered, or null when the agent
  never received it.
- d9330e8: feat: add `isPrincipalOnlyPermission` for the permissions apps never hold.
- 6cf853e: feat!: project scopes name their owner as a scope
  (`{ kind: "project", owner: { kind: "org", orgId }, projectId }`), and project segments embed the
  owner's segment (`project:org:<orgId>:<projectId>`).
- 51fc025: feat: `pi.prompt.submit` accepts `notifyWhenDone`, which notifies the calling agent, also
  in another scope, with the `turn.*` or `queue.dropped` event recording how the prompt ended.
- 5e469b1: feat: add the `invitations.create` provisioning operation, so a first-party app invites
  people as a member who authorized it.
- 38d0b8a: feat: add the `v0/provisioning` contract and `createBackofficeProvisioningClient` for
  first-party apps.
- 9ffd7fc: feat!: file links return `url` at Backoffice's public address, for people and services,
  and `sandboxUrl` for sandbox commands. Sandbox commands that used `url` switch to `sandboxUrl`.
- 47cff6f: feat!: remove the `capabilities.list` operation, the `capabilities.read` permission, and
  the `v0/capabilities` export. Use `integrations.discover` and `integrations.list` for connection
  status; `hooks.scopes.list` and `HookScopesListOutput` move to `v0/hooks`.
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
- 40439d5: feat: organization and user scopes name the jurisdiction their objects are kept in
  (`"eu"`, `"us"`, or `null` for no preference), and organization records and provisioning results
  report it. Scopes parsed without one read as `null`, which is what every owner created before
  jurisdictions has; add `jurisdiction` wherever you build an organization or user scope.
- 65705da: feat: add `backofficeScopeProjectOwner`, the scope whose projects sit beside a workspace.
- b254c6c: feat: add scope parsing, comparison, and parse errors to v0/shared/scope, with strict
  scope schemas.
- 9b33701: feat: export `STATE_FILE_MAX_BYTES`, the most bytes one workspace file holds.
- 9766eb4: feat!: `state.searchFiles` takes `keywords` (1–8 strings, matching any) instead of
  `query`; pass `keywords: [query]` to migrate.
- 169c08d: feat: remove the `telegram.*` and `resend.*` operations and the `telegram`, `resend`, and
  `reson8` permissions; the `backoffice#telegram` and `backoffice#resend` integrations replace them.
  `hooks.get` explains where an ingested event's payload sits.
- bca40c1: feat: publish each integration action's `validation` and run unchecked actions with
  `integrations.execute`'s `unchecked: true`.
- ac09cc7: feat: Add `upload.createDownloadLink` and `upload.createUploadLink`, which return
  temporary URLs that sandbox commands use to read or write workspace files.
- d37365b: feat: add `web.download`, which saves the file behind a public https URL into the
  workspace, behind the new `web.download` permission.
- 4dbcbde: feat: remove the `api.webhooks.*` operations; inbound webhooks are set up as
  `webhook#<endpointId>` integrations. `secretFields` names nested secrets as dot-separated paths.
- 7fe6622: feat: add the `workflow.instances.show` operation, which shows a durable workflow
  instance to the user as a card in the agent's conversation.
- 6e9ad46: feat: `workflow.instances.create` accepts `notifyWhenDone`, which notifies the calling
  agent, also in another scope, with a `workflows` `instance.completed` event naming the run's
  scope, status, output, and error.
- 1b61e2c: feat: add the `workflow.instances.terminate` operation, which terminates a durable
  workflow instance that has not ended yet and requires `workflow.modify`.
- ede5ff8: feat: add `backofficeWorkspaceOrganization`, the organization whose own workspace a scope
  is.
- dc1d027: feat!: remove the `upload.*` operations. Uploads are ordinary workspace files: read them
  with the `state.*` operations. File links move to `state.createDownloadLink` and
  `state.createUploadLink`, and the `FileLink` and `FileLinkInput` types to `v0/state`.
- 5c22724: feat: `pi.prompt.submit` accepts `subagent`, which runs the prompt in a new conversation
  of the agent beside its own, and `pi.agent.messages` accepts `subagent` to read that conversation.
- aab1688: fix: remove `followUp` from Pi prompt `whenBusy`; busy sessions take prompts as steering
  input.
- 4c3ba00: feat: Add scoped project creation and cursor-paginated listing APIs.
- f5a9356: feat: add the `organizations.provisionForInvitee` provisioning operation, which creates
  an organization with a pending owner invitation for someone who need not have signed in yet
