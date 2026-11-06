---
"@fragno-dev/backoffice-api": patch
---

feat!: remove the `forms` permissions and the `forms.list`, `forms.create`, `forms.update`, and
`forms.submissions.list` operations, as Backoffice no longer hosts Forms. Callers have no
replacement; drop these operations and permissions from clients and role definitions.
