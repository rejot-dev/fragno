### Create GitHub Issue

Use the `gh` (GitHub CLI) to create an issue in the Fragno repository.

## Steps

1. Understand the context of the issue
1. Write a concise issue title + description
1. Present ONLY the issue in a markdown code block - no additional commentary
1. On a new line after the code block, ask: "If this looks good, say 'yes'. If anything needs to be
   changed, please suggest changes."
1. Take into account the user's feedback and keep repeating until the user is satisfied
1. Create the issue
1. Respond with ONLY: "Issue created: [title](url)" in markdown link format, nothing else

## Rules:

- Present the issue in a code (MARKDOWN) block.
- Add a label for the package that the issue is related to, AND a label for the type of issue. E.g.
  enhancement, bug, etc.
- Do NOT add any commentary, explanation, or repeated information outside the code block when
  presenting the issue.
- After creating the issue, respond with only the CLICKABLE Markdown link, no additional text.
- DO NOT mention "Files to Update" UNLESS you are absolutely sure. You can only be sure if you did
  planning / research beforehand. You MAY add "Directions" that points to file with a (very short)
  disclaimer.
- Labels should NOT be part of the issue body.

## Labels:

### Packages Based:

[LABEL] - [FOLDER]

- core - packages/fragno
- cli - apps/fragno-cli
- db - packages/fragno-db

- documentation - apps/docs

- examples - example-apps/, example-fragments/

- create - packages/create, packages/create-cli

- node packages/fragno-node
- unplugin-fragno packages/unplugin-fragno

### Issue Types:

- bug
- enhancement
