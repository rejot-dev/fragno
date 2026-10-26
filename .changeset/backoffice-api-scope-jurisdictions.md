---
"@fragno-dev/backoffice-api": patch
---

feat: organization and user scopes name the jurisdiction their objects are kept in (`"eu"`, `"us"`,
or `null` for no preference), and organization records and provisioning results report it. Scopes
parsed without one read as `null`, which is what every owner created before jurisdictions has; add
`jurisdiction` wherever you build an organization or user scope.
