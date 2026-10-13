# Goal: complete the Backoffice product description

Work in `apps/backoffice/product-description`. Read `README.md`, `glossary.md`, and the feature
documents before drafting. README's structure and coverage table define the work list. Describe
signed-in web Backoffice, not its implementation packages or APIs.

## Source of truth

The source checkout is `/Users/wilco/dev/fragno` at commit `7dd3c31b5` as captured at the start of
this description. The live surface is `http://127.0.0.1:5173/backoffice`. The running browser
session is signed in as Wilco with “Wilco's Organization” selected. That is an observed account
state, not a default fixture for all users.

## Reading order

For each feature, read the route entry and loader/action first, then the relevant UI components,
shared shell and scope helpers, relevant domain code and authority checks, and finally colocated
tests—especially `*.scenario.test.*`. Read `apps/backoffice/app/routes.ts` to understand nested
route structure. Main areas are `routes/backoffice/automations/`, `sessions/`, `files/`,
`marketplace/`, organization administration, and `connections/`. Do not infer a user-facing
guarantee from a type name or implementation alone.

## Writing rules

- Follow the eight-section feature skeleton described in README; keep the five interaction phases
  arrive, leave untouched, begin editing, while editing, submit in every document.
- Keep fixed interrupt rows and cross-cutting concerns in README's exact order. Fill every cell,
  including “No effect” when supported by evidence.
- Use glossary terms consistently. Add a definition before introducing a term of art.
- Keep prose user-facing. Technical details belong only in `> Technical note:` blocks when they
  explain surprising behavior.
- Include a Mermaid `stateDiagram-v2` for each interaction.
- Give every feature an “Open questions and verification” section and footer:
  `Verified against /Users/wilco/dev/fragno commit {short-sha}`.
- Do not claim visual verification based on code or automated tests. If behavior is uncertain,
  record the uncertainty and continue.

## Things already established

- The browser app exposes top-level Automations, Sessions, Files, and Marketplace navigation in the
  observed signed-in application shell.
- The header exposes a scope switcher, project selector, account menu, and activity control.
- The observed page was `/backoffice/automations/org/wilcos-organization/dashboard`, titled
  “Automations · Wilco's Organization”. Its visible workspace sections were Orchestration, Events,
  Store, API, Integrations, MCP, and Sandboxes.
- The live view showed a Projects event source, a disabled “Configure project files” event trigger,
  and a workflow start node named `project-files-configure`. This is only a snapshot; do not
  generalize seeded content.
- Route definitions are nested and scope-bearing; consult `app/routes.ts` for exact paths.
- No universal behavior threshold, autosave interval, or dirty-navigation warning is established. Do
  not invent one.
- The scope selector offers System only to global admin users, organizations in membership data, and
  Personal; while in project scope it displays the parent organization and leaves project choice to
  the adjacent selector.
- Scope switching preserves only recognized section tabs. System scope falls back to Automation
  Dashboard from API, MCP, and Sandboxes; Sessions routes to the scoped list and Files to its scoped
  root.
- Organization management UI treats global admin or organization owner/admin as managers.
  Invitations default to member and are not emailed automatically; a shareable link is generated
  after success. Users cannot edit their own roles in the member list.
- Files roots are `/system` for System and `/static` plus `/workspace` in other scopes. `/workspace`
  is the default selected root; content search requests at most 50 matches per source with one
  context line before/after.
- Automation dashboard selection uses URL query state; inspector minimum width is 320 px; swimlane
  content minimum width is 43 rem. These values are implementation defaults to verify visually.
- A blank/whitespace session message is ignored. While a session is running, a new send passes the
  current command kind as its busy policy; compact is disabled while running. Compaction
  instructions come from trimmed composer text and the composer clears only on completed compaction.
- Appearance defaults to System theme and follows OS reduced-motion preference until a valid
  explicit preference is stored in local storage.
- Organization billing defaults to the current UTC month, and the Next month link is omitted beyond
  the current UTC month. It is labeled estimated total.
- Marketplace install targets a folder under `/workspace`; conflicting files stop installation;
  admission of the ingestion workflow is distinct from completion. Draft creation is private
  metadata-only and does not email or publish automatically.
- Resend send requires recipients, subject, and text or HTML and returns a queued record; queue
  acceptance is not delivery. Telegram bot token is never displayed after save.
- Ownership of each feature's internal states belongs to its feature document; shared navigation,
  scope, identity/access, and async persistence rules belong to foundations.

## Order of work

1. Draft foundations in the order listed in README, then area documents. If an area cannot be
   adequately researched, leave it explicitly not started rather than creating a shallow
   placeholder.
2. For each document, read the state-owning route/component, relevant domain services, and scenario
   tests before writing.
3. Update README's coverage table only when the corresponding file is drafted. Do not mark anything
   verified until the applicable hand checklist has been completed manually.
4. Add a checklist table for each drafted document, with stable IDs, observable claims, reproducible
   setup/steps, priority, and result `—` until run.
5. Run the skill's link checker and reconcile links, footers, section names, glossary terms, and
   list ordering.

## Working rules

- Never change application source for this documentation task. Output is confined to
  `apps/backoffice/product-description`.
- The running app is available on port 5173. Do not kill or restart it unless verification requires
  that.
- Do not create commits unless asked. If requested later, use the project's expected commit
  convention.
- State suspected defects plainly in the document and deduplicate them in `bug-triage.md` only when
  supported by an identified behavior and code cause.
- When code and tests do not settle a question, write the known portion, identify what remains
  unknown, and move on.
