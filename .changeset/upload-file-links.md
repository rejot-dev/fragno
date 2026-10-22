---
"@fragno-dev/upload": patch
---

feat: Add signed file links: `POST /file-links` issues an expiring URL that reads or writes one
file, or a glob of files as a tar archive, without the integrator's authentication.
