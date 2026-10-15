---
"@fragno-dev/backoffice-api": patch
---

feat!: project scopes name their owner as a scope
(`{ kind: "project", owner: { kind: "org", orgId }, projectId }`), and project segments embed the
owner's segment (`project:org:<orgId>:<projectId>`).
