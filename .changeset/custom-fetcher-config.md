---
"@fragno-dev/core": patch
---

Add custom fetcher configuration support for ClientBuilder

Fragment authors can now provide default fetch configuration when creating clients, and users can
override or extend these settings. Supports both RequestInit options (credentials, headers, etc.)
and custom fetch functions.
