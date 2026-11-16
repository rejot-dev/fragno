---
"@fragno-dev/db": patch
---

feat: bind `in` lists of any length on SQLite as JSON, so lookups by many values stay within Durable
Object SQLite's 100 bound parameters without splitting them by hand.
