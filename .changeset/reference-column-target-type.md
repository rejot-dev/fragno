---
"@fragno-dev/db": patch
---

feat: `referenceColumn({ table })` types its values as `FragnoReferenceTo<table>`, a
`FragnoReference` that names the referenced table in its type, so consumers can type relationships
