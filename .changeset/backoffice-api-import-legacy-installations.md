---
"@fragno-dev/backoffice-api": patch
---

feat: `packages.importLegacy` imports installations from the legacy `marketplace-lock.json` and
deletes it. Installing into a workspace that still has the file is refused until it is imported.
