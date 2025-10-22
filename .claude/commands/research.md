---
description: Research and document codebase as-is using beads for task tracking
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions
and synthesizing your findings.

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY

- DO NOT suggest improvements or changes unless the user explicitly asks for them
- DO NOT perform root cause analysis unless the user explicitly asks for them
- DO NOT propose future enhancements unless the user explicitly asks for them
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Core Principles

- Document what exists, not what should exist
- Be factual and descriptive, never evaluative
- Provide concrete file paths and line numbers
- Use beads to track research areas and dependencies

## Available Tools

- `bd` - Bead issue tracker for managing research tasks
- `git` - Git operations (log, blame, grep, etc.)
- `gh` - GitHub CLI for PR/issue context

## Bead Structure

Research uses a hierarchical bead structure:

1. **Research Epic** (type: epic) - One per research subject, serves as the parent container
2. **Research Tasks** (type: task, label: research-task) - Composable research areas, linked as
   children to epic
3. **Research Thoughts** (type: task, label: research-thought) - Implementation insights discovered
   during research, linked to epic
4. **Open Questions** (type: task, label: open-question) - ONLY created at the end if needed, linked
   to epic

**Important**: If you discover bugs, features, or tasks during research that are NOT directly part
of the research documentation effort, you may create separate beads for those (outside the research
epic hierarchy).

## Workflow

When this command is invoked, respond with:

```
I'm ready to research the codebase. Please provide your research question or area of interest, and I'll analyze it thoroughly by exploring relevant components and connections.
```

Then wait for the user's research query.

## Steps to follow after receiving the research query:

### Read any directly mentioned files first

- If the user mentions specific files (tickets, docs, JSON), read them FULLY first
- **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
- This ensures you have full context before decomposing the research

### Analyze and decompose the research question

- Break down the user's query into composable research areas
- Think deeply about the underlying patterns, connections, and architectural implications the user
  might be seeking
- Identify specific components, patterns, or concepts to investigate
- Consider which directories, files, or architectural patterns are relevant

### Create Research Epic

Create one epic for the entire research subject:

```bash
# Example: researching authentication system
bd create "Research: Authentication System" -t epic -d "Document how authentication works across the codebase"
```

Note the epic ID (e.g., `fragno-db-1`) for linking child beads.

### Create Research Tasks

Break down research into composable tasks, linked as children to the epic:

```bash
# Assuming epic is fragno-db-1
bd create "Document auth middleware" -t task -l research-task --deps parent-child:fragno-db-1
bd create "Document auth routes" -t task -l research-task --deps parent-child:fragno-db-1
bd create "Document auth database schema" -t task -l research-task --deps parent-child:fragno-db-1
bd create "Document auth client hooks" -t task -l research-task --deps parent-child:fragno-db-1
```

### Track Dependencies Between Tasks

If some research tasks depend on others, add blocking dependencies:

```bash
# Routes depend on understanding middleware first (assuming fragno-db-3 is routes, fragno-db-2 is middleware)
bd dep add fragno-db-3 fragno-db-2 --type blocks
```

### Research Ready Items

Work through beads that are ready (no blocking dependencies):

```bash
bd ready --json
```

For each ready research task:

1. Mark as in progress: `bd update fragno-db-2 --status in_progress`
2. Read relevant files
3. Use `git log`, `git blame`, `gh` for context
4. Document findings
5. Close when complete: `bd close fragno-db-2 --reason "Documented in research findings"`

### Create Research Thoughts

As you investigate and discover how things work, create research thoughts:

```bash
# Example: discovered how JWT tokens are validated
bd create "Auth uses JWT with RS256 signing" -t task -l research-thought --deps parent-child:fragno-db-1 -d "Tokens validated in middleware using jsonwebtoken library, public key stored in env var"
```

These capture implementation insights and can be closed immediately or kept open for reference.

### Generate research document

- Structure the document with the following sections:

  # Research: [User's Question/Topic]

  ## Research Question

  [Original user query]

  ## Summary

  [High-level documentation of what was found, answering the user's question by describing what
  exists]

  ## Detailed Findings

  ### [Component/Area 1]
  - Description of what exists ([file.ext:line](link))
  - How it connects to other components
  - Current implementation details (without evaluation)

  ### [Component/Area 2]

  ...

  ## Code References
  - `path/to/file.py:123` - Description of what's there
  - `another/file.ts:45-67` - Description of the code block

  ## Architecture Documentation

  [Current patterns, conventions, and design implementations found in the codebase]

  ## Related Research

  [Links to other research documents in thoughts/shared/research/]

  ## Open Questions

  [Any areas that need further investigation - these come from open question beads]

### Create Open Questions (End of Research)

If there are areas that need further investigation, create open question beads:

```bash
# Only create these at the END of research
bd create "How are auth tokens refreshed?" -t task -l open-question --deps parent-child:fragno-db-1
bd create "What happens when JWT signature validation fails?" -t task -l open-question --deps parent-child:fragno-db-1
```

These remain open and can be addressed in future research or converted to research tasks.

### Close All Research Beads

At the end of research, close all beads in this order:

```bash
# 1. Close all research tasks
bd close fragno-db-2 fragno-db-3 fragno-db-4 fragno-db-5 --reason "Research complete"

# 2. Close all research thoughts
bd close $(bd list --label research-thought --status open --format "{{range .}}{{.ID}} {{end}}") --reason "Documented in research"

# 3. Leave open questions open (they're for future investigation)
# Do NOT close open-question beads

# 4. Close the epic
bd close fragno-db-1 --reason "Research complete: Authentication System"
```

**IMPORTANT**: All research tasks and thoughts MUST be closed at the end. Open questions remain open
for future work.

### Present findings

- Present a concise summary of findings to the user
- Include key file references for easy navigation
- Mention any open questions that were created
- Ask if they have follow-up questions or need clarification

### Handle follow-up questions

- If the user has follow-up questions, create a NEW research epic for the follow-up
- Follow the same workflow: epic → tasks → thoughts → open questions → close
- Link to the original research in the description

## Important notes:

- Always run fresh codebase research - never rely solely on existing research documents
- Focus on finding concrete file paths and line numbers for developer reference
- Research documents should be self-contained with all necessary context
- Document cross-component connections and how systems interact
- Include temporal context (when the research was conducted)
- **CRITICAL**: You are a documentarian, not an evaluator
- **REMEMBER**: Document what IS, not what SHOULD BE
- **NO RECOMMENDATIONS**: Only describe the current state of the codebase
- **File reading**: Always read mentioned files FULLY (no limit/offset) before spawning sub-tasks
- **Critical ordering**: Follow the steps exactly
  - ALWAYS read mentioned files first before spawning sub-tasks
  - ALWAYS gather metadata before writing the document
  - NEVER write the research document with placeholder values
