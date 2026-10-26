---
"@fragno-dev/backoffice-api": patch
---

feat: automation event subjects name the scope they are about in full as `subject.scope`, which
replaces `subject.orgId`, and `forward_event` can target `{ kind: "subject" }` to deliver an event
to that scope. Read `subject.scope.orgId` where you read `subject.orgId`, and match
`$.subject.scope.kind` instead of `$.subject.orgId`.
