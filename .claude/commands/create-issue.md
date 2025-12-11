### Create GitHub Issue

Use the `gh` (GitHub CLI) to create an issue in the Fragno repository.

## Steps

1. Understand the context of the issue
1. Write a concise issue title + description
1. Write the issue to a markdown file (add line breaks at column 100)
1. Present ONLY a link to the markdown file - no additional commentary. DO NOT include title/labels
   in the markdown body.
1. On a new line after the code block, ask: "If this looks good, say 'yes'. If anything needs to be
   changed, please suggest changes."
1. Take into account the user's feedback and keep repeating until the user is satisfied
1. Create the issue (use the file)
1. FIRST Respond with ONLY: "Issue created: [title](url)" in markdown link format, nothing else
1. THEN Delete the markdown file

## Rules:

- Present the issue in a markdown file.
- Add a label for the package that the issue is related to, AND a label for the type of issue. E.g.
  enhancement, bug, etc.
- Do NOT add any commentary, explanation, or repeated information when presenting the issue.
- After creating the issue, respond with only the CLICKABLE Markdown link, no additional text.
- DO NOT mention "Files to Update" UNLESS you are absolutely sure. You can only be sure if you did
  planning / research beforehand. You MAY add "Directions" that points to file with a (very short)
  disclaimer.
- Labels should NOT be part of the issue body.
- End the issue text with: `_Disclaimer: issue written by LLM agent_` (on a new line)

## Labels:

### Packages Based:

[LABEL] - [FOLDER]

- core - packages/fragno
- cli - apps/fragno-cli
- db - packages/fragno-db

- documentation - apps/docs

- examples - example-apps/, example-fragments/, packages/corpus/

- create - packages/create, packages/create-cli

- node packages/fragno-node
- unplugin-fragno packages/unplugin-fragno

### Issue Types:

- bug
- enhancement
- refactor
