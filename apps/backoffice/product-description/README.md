# Backoffice product description

A written description of Backoffice's user experience: what a signed-in user sees, what they can do,
and what happens when they do it.

## Purpose

Backoffice is a browser application for operating automation workspaces: users configure
event-driven workflows, inspect sessions, manage files, connect services, and share or install
reusable automation artifacts. Its behavior is distributed across route loaders and actions, client
components, domain services, and scenario tests. This directory describes that product from the
user's point of view, not by package.

The described surface is the signed-in Backoffice application at `http://127.0.0.1:5173/backoffice`,
in its current development defaults. The observed browser session is an authenticated user in the
organization “Wilco's Organization”; user- and organization-specific data shown in that session is
evidence for the verification note, not a universal default.

### What this is not

- Not API documentation. Route and fragment contracts are defined in `apps/backoffice/app/routes`
  and `apps/backoffice/app/fragno`.
- Not organized by package. The account's journey, not implementation modules, determines the
  structure.
- Not a technical design document. Implementation detail appears only in `> Technical note:` blocks
  when it changes what a user should expect.

## Conventions

- Describe the experience, not the code.
- Use sentence case and concrete language; flag uncertainty rather than guessing.
- The [glossary](glossary.md) owns shared product terms.
- Feature documents use the same eight sections: summary, simple case, interaction event by event,
  modifiers, cancel and interrupt, interactions with other systems, edge cases, and open questions
  and verification.
- Every feature document ends with the source commit it was checked against. Verification status
  means a human checked observable behavior in the running app; reading code or running tests alone
  does not count.

## The work to be done

A feature document describes a user-facing capability. The interaction is a **page/form lifecycle**:
arrive → leave untouched → begin editing → edit → submit. A given page may include long-running
operations, which are described as part of the submit/operation flow, not as a second template.
Variants are the scope (personal, organization, or project), access authority, record/workflow
state, and browser/network state.

Every feature uses the same interruption checklist, in this order: explicit cancel; navigate or
switch feature; another action completes the current work; network/request/session failure; reload
or close; target changed elsewhere or no longer accessible; browser/input channel changes;
feature-specific state change. Every feature considers the following concerns, in this order:
permissions; persistence/history; parent scope; readonly/restricted state; offline;
collaboration/multiple tabs; notifications; preferences and URL state; external integrations/side
effects; accessibility and analytics.

### Document template

1. **Summary** — what the user can accomplish and where.
2. **The simple case** — the ordinary successful path.
3. **The interaction, event by event** — arrive, leave without editing, begin editing, while
   editing, submit; include a Mermaid state diagram.
4. **Modifiers** — scope, authority, target state, and browser/network variants, each considered at
   arrival and during editing.
5. **Cancel and interrupt** — the fixed interruption checklist above, with before-editing and
   during-operation behavior.
6. **Interactions with other systems** — the fixed cross-cutting concerns above.
7. **Edge cases** — observable boundaries and unusual outcomes.
8. **Open questions and verification** — unresolved questions and exact source commit.

## Method

Draft from route definitions, user-facing UI, domain behavior and scenario tests; verify in the live
browser where possible. Treat scenario tests as executable evidence for state changes, but not as
proof of visual presentation or timing. Record suspected defects in `bug-triage.md`; do not silently
describe them as intended behavior.

## Scope decisions

- **Product and surface:** Backoffice's signed-in web application under `/backoffice`; default
  application configuration. The current browser session is authenticated as “Wilco” and scoped to
  “Wilco's Organization”.
- **Source of truth:** this Fragno checkout at `/Users/wilco/dev/fragno`, commit `7dd3c31b5` at the
  start of this work. This commit is recorded in drafted feature footers.
- **Verification entry point:** the already-running development app at `http://127.0.0.1:5173`;
  package script is `pnpm --dir apps/backoffice dev`. No restart was needed for the initial visual
  check.
- **Out of scope:** public marketing/landing pages, raw API consumers and external OAuth provider
  interfaces, deployment/hosting operations, internal developer-only internals pages, and
  implementation/API reference. Auth entry and organization context are covered only as needed to
  explain access to the signed-in product.
- **Destination:** `apps/backoffice/product-description` inside the source checkout, as requested;
  this is documentation output and the application source is not changed.
- **Interaction shape:** the unit is a page/form lifecycle with phases arrive, leave untouched,
  begin editing, while editing, submit. Fixed variants, interrupts, and cross-cutting order are
  defined above and should not change without revisiting the set.

## Structure

```
README.md                         purpose, scope, conventions, work plan
AGENTS.md, CLAUDE.md              instructions for future drafting sessions
goal.md                           standing drafting instructions and established facts
glossary.md                       shared product vocabulary
bug-triage.md                     deduplicated suspected defects
foundations/
  navigation-and-scope.md         routes, scope selection, and shared application shell
  identity-and-access.md         sign-in, organizations, and access boundaries
  persistence-and-async-work.md  saved state, requests, sessions, and long-running work
areas/
  automations.md                  automation dashboard, sources, routes, and event catalog
  automation-store.md             scoped key/value entries and external identity bindings
  api-connections.md              outbound API connections and inbound webhooks
  mcp-servers.md                  remote MCP server setup and tool discovery
  sandboxes.md                    isolated command execution environments
  sessions.md                     creating and inspecting agent sessions
  files.md                        scoped file browsing and file operations
  upload-management.md            organization Upload providers and file transfer management
  marketplace.md                  browsing, installing, and publishing artifacts
  organizations.md                organization overview, members, invitations, billing
  integrations.md                 connecting and operating external services
  account-and-settings.md         account menu, user settings, and preferences
verification/
  README.md                       hand-verification protocol and observed coverage
  foundations.md                  foundation claims checklist
  workspace.md                    automation dashboard, sessions, and files checklists
  operations.md                    Store, API, MCP, sandboxes, and Upload checks
  sharing.md                      marketplace, organization, and integration checklists
```

## Coverage

Status is `not started`, `drafted`, or `verified`. `Verified` requires a manual pass in the running
application for the P1/P2 claims in the applicable checklist.

| Document                                  | Status  |
| ----------------------------------------- | ------- |
| glossary.md                               | drafted |
| foundations/navigation-and-scope.md       | drafted |
| foundations/identity-and-access.md        | drafted |
| foundations/persistence-and-async-work.md | drafted |
| areas/automations.md                      | drafted |
| areas/automation-store.md                 | drafted |
| areas/api-connections.md                  | drafted |
| areas/mcp-servers.md                      | drafted |
| areas/sandboxes.md                        | drafted |
| areas/sessions.md                         | drafted |
| areas/files.md                            | drafted |
| areas/upload-management.md                | drafted |
| areas/marketplace.md                      | drafted |
| areas/organizations.md                    | drafted |
| areas/integrations.md                     | drafted |
| areas/account-and-settings.md             | drafted |
| verification/README.md                    | drafted |
| verification/foundations.md               | drafted |
| verification/workspace.md                 | drafted |
| verification/operations.md                | drafted |
| verification/sharing.md                   | drafted |
| bug-triage.md                             | drafted |

## Reference

Source of truth: `/Users/wilco/dev/fragno`, commit `7dd3c31b5`.

- `apps/backoffice/app/routes.ts`: route map and page hierarchy.
- `apps/backoffice/app/components/backoffice/shell.tsx`, `sidebar-nav.tsx`, `top-bar.tsx`: global
  shell, navigation, scope/project/account controls.
- `apps/backoffice/app/routes/backoffice/automations/`: automation workspace, event catalog, store,
  API, MCP, and sandbox screens.
- `apps/backoffice/app/routes/backoffice/connections/`: organization Upload administration and other
  external connections.
- `apps/backoffice/app/routes/backoffice/sessions/`: session list, creation, detail, streaming and
  actions.
- `apps/backoffice/app/routes/backoffice/files/` and `app/components/backoffice/files-explorer/`:
  file navigation and display.
- `apps/backoffice/app/routes/backoffice/marketplace/`: browse, detail, install, publish, and
  management.
- `apps/backoffice/app/routes/backoffice/organization-*.tsx`: organization administration.
- `apps/backoffice/app/routes/backoffice/connections/` and scoped integration routes: service
  connections and operation.
- `apps/backoffice/app/fragno/automation/` and `app/fragno/auth/`: domain behavior, authorization
  and test scenarios.
- `apps/backoffice/app/routes/**/*.scenario.test.*`, colocated `*.test.*`: user-flow and edge-case
  evidence.
- `apps/backoffice/app/routes.ts`, `app/backoffice-runtime/permissions.ts`, and shared route scope
  helpers: route boundaries and authority checks.
- Live surface observed:
  `http://127.0.0.1:5173/backoffice/automations/org/wilcos-organization/dashboard`.
