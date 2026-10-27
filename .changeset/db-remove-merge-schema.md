---
"@fragno-dev/db": patch
---

refactor!: remove `SchemaBuilder.mergeWithExistingSchema()`, which Fragno no longer used. Define
each table in the schema that owns it; fragments keep their schemas apart under their own
namespaces.
