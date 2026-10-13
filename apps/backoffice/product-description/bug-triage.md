# Bug triage

A consolidated list of suspected defects found while describing Backoffice, deduplicated by cause.
One issue has been observed in the running app and is marked with a verification Status. Further
feature coverage may add entries; absence of other entries is not evidence that the rest of
Backoffice is defect-free.

## Summary

One medium-severity issue is currently recorded: session history uses a timestamp formatter whose
timezone is not pinned, and the first server-rendered text differed from the browser-rendered time
in the observed session list. This caused a React hydration error and a two-hour visible timestamp
shift between observations. No external issue has been filed.

| ID   | Title                                                        | Severity | Area     | Decision needed | Issue |
| ---- | ------------------------------------------------------------ | -------- | -------- | --------------- | ----- |
| B-01 | Session history timestamps differ between server and browser | medium   | Sessions | fix             | —     |

## Medium

### B-01: Session history timestamps differ between server and browser

- **Where the user meets it:** The History list on a scoped Sessions page, beside the New session
  composer.
- **What happens / what was expected:** On a direct visit, the browser console logged React
  hydration error #418. The history showed a timestamp of 3:40 PM; after reloading the same page,
  the same stored session appeared at 1:40 PM. The user should see a stable time and the page should
  hydrate without a text mismatch.
- **Reproduce:**
  1. Open `/backoffice/sessions/org/{orgSlug}/sessions` in a browser whose timezone differs from the
     Node server timezone.
  2. Inspect the visible session-history timestamp and browser console immediately after navigation.
  3. Reload and compare the same session's timestamp.
- **Why (from the code):** `apps/backoffice/app/routes/backoffice/sessions/formatting.ts:1-4`
  creates `Intl.DateTimeFormat` with no explicit `timeZone`, so server and browser environments can
  format the same instant in different zones. `formatTimestamp` uses that formatter at lines 6-11,
  and `apps/backoffice/app/routes/backoffice/sessions/new-session-composer.tsx:171-172` renders it
  in server-rendered history. Pinning the product's intended timezone or deferring browser-local
  formatting until after hydration would remove the environment-dependent initial text; the intended
  display timezone is a product decision if not already defined elsewhere.
- **Severity:** `medium`. Session history remains navigable, but hydration recovers by client
  rendering and the displayed time changes, which can mislead users about when a session was
  created.
- **Decision needed:** `fix`. Choose and consistently apply a timezone for server and client
  rendering (or make local-time rendering hydration-safe).
- **Raised by:** [Sessions](areas/sessions.md#open-questions-and-verification),
  [SESS-06](verification/workspace.md#areassessionsmd).
- **Status:** Confirmed on October 11, 2026, in the running browser by direct navigation and reload.
  The first navigation logged React error #418 and showed 3:40 PM; reload showed 1:40 PM for the
  same session. The exact environment timezone pair was not measured.
