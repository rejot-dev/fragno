# Verification: foundations

How to run this file: use a signed-in desktop browser and test personal and organization scopes
available to the account. A project scope requires a project-bearing organization. An admin account
is needed for System scope. Preserve test data; do not use production credentials for destructive
operations.

## foundations/navigation-and-scope.md

| ID     | P   | Device   | Claim                                                                                                                                                         | Setup                                                                         | Steps                                                                            | Expected                                                                                               | Result                                                      |
| ------ | --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| NAV-01 | P1  | browser  | The application shell displays the current scope and separates project selection ([Summary](../foundations/navigation-and-scope.md#summary)).                 | Sign in and open an organization-scoped route.                                | 1. Inspect the header. 2. Open a project-scoped route if available.              | Scope control shows the organization in both contexts; project is represented by an adjacent selector. | pass — visually observed on org route; project case not run |
| NAV-02 | P1  | browser  | Choosing a scope navigates to a destination rebuilt for that section ([Begin editing](../foundations/navigation-and-scope.md#begin-editing)).                 | Signed-in account with personal scope and one organization; open Automations. | 1. Open scope selector. 2. Choose Personal. 3. Inspect URL and selected section. | Route changes to personal automation dashboard and shell shows personal scope.                         | —                                                           |
| NAV-03 | P2  | browser  | Scope switching preserves supported section tabs and falls back for unsupported tabs ([Begin editing](../foundations/navigation-and-scope.md#begin-editing)). | Admin account on scoped Automations API page.                                 | 1. Switch to System. 2. Inspect destination.                                     | Destination is System Automations Dashboard, not API.                                                  | —                                                           |
| NAV-04 | P2  | keyboard | Dismissing the scope selector without a choice leaves scope and URL unchanged ([Leave untouched](../foundations/navigation-and-scope.md#leave-untouched)).    | Any signed-in scoped route.                                                   | 1. Open selector. 2. Press Escape. 3. Inspect URL and trigger.                   | Menu closes and the original scope/URL remain.                                                         | —                                                           |

Not checkable by hand:

- Whether authorization is correctly enforced for every route/scope combination; use route scenario
  tests and a broader authorization matrix.

## foundations/identity-and-access.md

| ID      | P   | Device  | Claim                                                                                                                                          | Setup                                                           | Steps                                                                                        | Expected                                                                  | Result |
| ------- | --- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| AUTH-01 | P1  | browser | Rejecting an invitation first asks for confirmation ([Leave untouched](../foundations/identity-and-access.md#leave-untouched)).                | Account with an open disposable organization invitation.        | 1. Activate Reject. 2. Cancel the confirmation. 3. Refresh the invitation list.              | Invitation remains open and no rejection success notice appears.          | —      |
| AUTH-02 | P1  | browser | Members cannot edit their own roles from the roster ([Begin editing](../foundations/identity-and-access.md#begin-editing)).                    | Organization manager account; view own member row.              | 1. Inspect role controls for own row. 2. Try keyboard focus on the row actions.              | Own role controls cannot be changed from this view.                       | —      |
| AUTH-03 | P2  | browser | Organization member search filters the currently loaded page ([Leave untouched](../foundations/identity-and-access.md#leave-untouched)).       | Organization roster with multiple pages and known member names. | 1. Search a name on this page. 2. Search a known name on another page without changing page. | Current-page matches show; off-page member is not loaded into results.    | —      |
| AUTH-04 | P2  | browser | Invalid login displays a retry-oriented error and does not enter the protected route ([Submit](../foundations/identity-and-access.md#submit)). | Disposable account; wrong password.                             | 1. Submit valid email with incorrect password.                                               | Sign-in does not complete and an error remains visible on the auth route. | —      |

Not checkable by hand:

- Complete role-to-permission mapping and route authorization matrix; validate with scenario tests
  and security review.

## foundations/persistence-and-async-work.md

| ID         | P   | Device  | Claim                                                                                                                                                                         | Setup                                                                                  | Steps                                                                                                | Expected                                                                                              | Result |
| ---------- | --- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| PERSIST-01 | P1  | browser | A server-accepted durable operation can continue after leaving its page ([Submit](../foundations/persistence-and-async-work.md#submit)).                                      | Disposable session or marketplace workflow with safe test inputs.                      | 1. Start the operation. 2. Navigate away after acceptance. 3. Return to its owning list/detail view. | Record whether it continued and what terminal state is shown; do not assume cancellation.             | —      |
| PERSIST-02 | P2  | browser | Browser storage failure is handled differently by local preferences and core synchronized data ([While editing](../foundations/persistence-and-async-work.md#while-editing)). | Dev browser with storage disabled/blocked; test workspace view and appearance setting. | 1. Disable storage. 2. Load a local-first view. 3. Change theme. 4. Reload.                          | Record which view errors and whether the preference survives; compare with documented route behavior. | —      |

Not checkable by hand:

- Exact server transaction and replay guarantees across every durable workflow; use scenario tests
  and implementation review.

## areas/account-and-settings.md

| ID      | P   | Device  | Claim                                                                                                                                                               | Setup                                             | Steps                                                                              | Expected                                                                                                    | Result                                                                   |
| ------- | --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ACCT-01 | P2  | browser | Changing theme applies immediately and stores the preference ([Begin editing](../areas/account-and-settings.md#begin-editing)).                                     | Signed-in account; note current appearance first. | 1. Open account → Appearance. 2. Choose Light, then Dark. 3. Reload.               | Theme applies at each selection and last stored choice remains after reload.                                | —                                                                        |
| ACCT-02 | P1  | browser | Authorized applications shows personal OAuth consents and can revoke one ([While editing](../areas/account-and-settings.md#while-editing)).                         | Test account with disposable OAuth consent.       | 1. Open Settings → Authorized applications. 2. Revoke test client. 3. Reload list. | Consent no longer appears; if failure occurs, alert is shown and consent remains/reconciles on reload.      | —                                                                        |
| ACCT-03 | P2  | browser | Settings permission page labels grants as base grants and warns that action-level policy may still deny access ([Arrive](../areas/account-and-settings.md#arrive)). | Signed-in admin with personal and org scope.      | 1. Open Settings. 2. Inspect listed scopes and policy warning.                     | Server-resolved grants display for system/personal/org and warning about additional policy remains visible. | pass — observed October 11, 2026; three scopes and policy caveat visible |

Not checkable by hand:

- Whether revocation invalidates all token classes at remote consumers; inspect token lifetimes and
  OAuth scenarios.
