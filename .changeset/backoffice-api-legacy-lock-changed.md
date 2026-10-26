---
"@fragno-dev/backoffice-api": patch
---

fix: `packages.importLegacy` keeps a `marketplace-lock.json` that changes while importing, reporting
`lock: "changed"`, instead of deleting entries it never imported. Import again to pick them up.
