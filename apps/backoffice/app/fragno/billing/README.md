# Usage attribution

Billing is a usage ledger, not an invoice or payment system. Each organization and each user has a
Billing Durable Object, addressed by its scope. Existing organization object addresses and recorded
statements do not change.

`usage-billing.ts` selects the ledger with `backofficeScopeRootOwner`: work in a user's scope, their
projects, and their installed apps belongs to that user. Organization-owned work belongs to the
organization. The event retains its full execution scope for breakdowns. The caller, active
organization, and any future primary organization do not change attribution.

## Required recording

`UsageBilling` is an explicit choice between customer recording and system work. Customer scopes
require the Billing binding; a missing binding is an error, never a reason to skip recording.
Recorders have no optional callback or nullable payer. System work explicitly has no customer.

- Pi installs its billing extension for every agent. Committed model usage is delivered through a
  durable task, with a stable event ID and retries after delivery failures.
- Codemode persists a run and its start hook before executing a guest. The hook records one
  `codemode.executions` event per run, including failed runs. Module builds only compile and do not
  count as executions.
- Prerecorded Reson8 transcription awaits recording its request and reported duration. This
  synchronous producer has no durable outbox; provider success followed by a recording failure fails
  the call rather than pretending it was recorded.
- Sandboxes record `sandbox.instance.<instance type>` seconds, from the attempt to start a container
  until it stops. Each run's meter in the sandbox manager bills at least hourly through durable
  hooks, splits usage at UTC month starts, and stops at the container's lease if the manager never
  stops it. Instance time also prices CPU: Cloudflare bills CPU by active use, which only the
  container could report, and its user could forge.

Browser dictation streams directly to Reson8 and is not measured here. Workflow ticks do not yet
record their own executions. Sandbox network egress is not measured. These are measurement gaps, not
exceptions allowing customer usage with a missing billing dependency.

## Statements

`/backoffice/usage` reads only the authenticated user's ledger. There is no caller-selected user ID.
`/backoffice/organizations/:orgSlug/billing` retains its organization membership check. Both pages
show usage, not an amount due.

Future invoicing may combine an organization's ledger with eligible users' ledgers according to a
primary-organization policy. Do not move or duplicate events to implement that policy. Which
relationship applies to a billing period is deliberately undecided.

## Upgrade

The Pi directory and Codemode schemas append migrations dropping the obsolete organization-payer
columns without resetting conversations, runs, or statements. Existing workflow execution snapshots
are read without their old payer selection; new work follows their stored execution scope.

An old Codemode start hook retains its recorded organization destination when delivered or retried.
Pi upgrades its stored agent configuration while retaining the legacy destination separately. Old
billing task checkpoints keep that destination, even if Billing accepted an event before its local
acknowledgement was committed. New checkpoints explicitly select owner attribution. Existing billing
watermarks are preserved, so acknowledged model usage is not backfilled into a second ledger.

Historical organization statements remain where they were recorded. This upgrade does not move
previously attributed usage between ledgers.
