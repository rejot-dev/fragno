---
"@fragno-dev/workflows": patch
---

fix: skip a tick that meets a concurrent tick's step even when workflow code or a remote workflow
turns the conflict into an ordinary error.
