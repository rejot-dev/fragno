---
"@fragno-dev/backoffice-api": patch
---

feat: provisioning adds `organizations.provisionManaged` and `organizations.listManaged`, and
`projects.provision` and `invitations.create` accept users acting through the managing organization.
`org.get` answers `managingOrganization` and `through`.
