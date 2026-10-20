---
"@fragno-dev/backoffice-api": minor
---

Attribute agent usage to its scope's root owner instead of a caller-selected billing organization.
Remove `billingOrganizationId` from Pi configuration and prompt inputs, and replace the manager's
`provisioning` object with a required `provisioned` boolean. Personal agents no longer require an
organization. This is a breaking contract change.
