---
"@fragno-dev/github-app-fragment": minor
---

Installation webhooks now sync the installation from GitHub instead of applying their payload, so
deliveries that arrive out of order can no longer roll back a suspension, unsuspension, or
repository change. Each `installation` and `installation_repositories` delivery reads the
installation and its repositories through the app's GitHub API access and retries when GitHub is
unreachable.

The sync, which `POST /installations/:installationId/sync` also runs, marks an installation GitHub
answers 404 for as `deleted` and keeps a suspended installation's repositories instead of failing to
list them.

This is a pre-1.0 breaking change: processing installation webhooks now requires working GitHub API
credentials, and `applyInstallationSync` takes an `installation` that is either GitHub's current
installation or a deletion.
