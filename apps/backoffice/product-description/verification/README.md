# Hand verification

The feature descriptions are drafted from Backoffice code and scenario tests. This directory defines
how to check each observable claim in the running application. `—` means the check has not yet been
performed; code inspection is not a pass.

## What is here

| File                             | Covers                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| [foundations.md](foundations.md) | Shared application behavior and navigation/access foundations |
| [workspace.md](workspace.md)     | Automation dashboard, sessions, and Backoffice files          |
| [operations.md](operations.md)   | Store, API, MCP, sandboxes, and organization Upload           |
| [sharing.md](sharing.md)         | Marketplace, organizations, and integrations                  |

## How to run a pass

1. Use the already-running development app at `http://127.0.0.1:5173`. If it is not running, from
   the repository root run `pnpm --dir apps/backoffice dev`.
2. Sign in with a permitted test account. Avoid destructive changes to the currently seeded “Wilco's
   Organization” unless that data is disposable. Use a clean test organization for invitations,
   billing, integration, and publish/install flows.
3. Confirm source revision with `git -C /Users/wilco/dev/fragno rev-parse --short HEAD`. Feature
   footers are pinned to `7dd3c31b5`; a different result means the source moved and findings may be
   revision drift.
4. Read the linked document section before each checklist row. Follow the exact setup and steps;
   note browser, scope, role, and network conditions.
5. Run P1 claims first, then P2 and P3. Record `pass`, `fail`, or `blocked` with a short reason for
   non-pass results.
6. A failure is not automatically a product defect: determine whether the document is inaccurate or
   the product differs from the documented behavior. Record confirmed suspected defects in
   `bug-triage.md` with checklist IDs.
7. Mark a document `verified` only after its P1 and P2 observable claims pass or are dispositioned.
   A scripted test run alone does not satisfy this rule.

## Devices and conditions

- **Browser:** a desktop browser window at the default viewport. Repeat responsive claims at the
  narrow viewport specified by a checklist row.
- **Account role:** the role named in setup. Do not infer another member's access from the current
  account's view.
- **Second account:** use a distinct browser profile/session; another tab in the same profile is not
  an independent identity.
- **Offline:** browser network emulation or a disconnected network, with care to distinguish a
  request already in flight from a request not yet started.
- **External service:** use a dedicated test account/endpoint and never real customer data. If
  credentials or provider sandbox access are unavailable, mark blocked.

## Driving the product from a console or script

The browser and app's visible UI are the authority for visual and interaction claims. Tests and
route/API inspection can help establish stored state but do not replace real input for keyboard,
focus, navigation, or presentation checks. No supported global browser control handle has been
established for this description.

## Results so far

A browser reconnaissance pass was made in the existing app on October 11, 2026. On
`/backoffice/automations/org/wilcos-organization/dashboard`, it confirmed the signed-in shell, the
Automations/Events/Store/API/Integrations/MCP/Sandboxes navigation, a Projects event source, and a
disabled project-files trigger. On `/backoffice/files/org/wilcos-organization`, it confirmed
Workspace and Static roots with Workspace selected by default; opening `/workspace/hello.txt` showed
a plain-text preview and Download link. On the organization Marketplace route, it showed five
published packages and their card metadata. On `/backoffice/settings`, it showed the server-resolved
System, Personal, and Organization scopes and the caveat that an individual action can still be
denied by additional policy. On `/backoffice/sessions/org/wilcos-organization/sessions`, the first
direct visit logged React hydration error #418 and showed a history time of 3:40 PM; a reload showed
the same session at 1:40 PM. This was recorded as SESS-06 and confirmed in B-01. Checklist rows
NAV-01, FILE-01, and ACCT-03 are marked pass for the specific claims observed; SESS-06 is a
failed/suspected-bug result. No document is marked verified. The pass did not exercise mutation
controls, submit forms, test authorization denial, complete a download, search contents, test
responsive behavior, or measure timing. It did not configure API/MCP connections, start a sandbox,
use the automation Store, or exercise organization Upload management; see
[operations checklist](operations.md). A browser console warning reported local OPFS persistence
still opening; it was not independently reproduced or triaged as a defect.
