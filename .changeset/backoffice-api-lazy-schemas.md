---
"@fragno-dev/backoffice-api": patch
---

perf!: build contract schemas on first use. Module-level schemas are now `z.ZodLazy`; use
`schema._zod.innerType` for `.extend`, `.shape`, `.pick`, and similar.
