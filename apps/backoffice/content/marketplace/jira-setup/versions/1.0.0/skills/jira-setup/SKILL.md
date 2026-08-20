---
name: jira-setup
description:
  Set up, verify, or use Jira Cloud in Backoffice with an Atlassian account email and API token. Use
  when connecting a Jira site, creating or searching issues, updating fields, adding comments,
  transitioning tickets, or discovering Jira projects and issue types.
---

# Jira setup

Set Jira Cloud up as one handshake: **connect → verify → discover → act**.

## 1. Inspect existing API connections

The API capability is available automatically for the current scope. Inspect the existing outbound
API connections before creating or replacing Jira. Reuse an active connection whose slug is `jira`
and whose base URL matches the requested Jira site.

**Complete when** the existing Jira connection and its base URL are known.

## 2. Collect missing credentials

Jira Cloud API-token authentication requires:

- the Jira site URL, such as `https://example.atlassian.net`;
- the Atlassian account email;
- an Atlassian API token, not the account password.

Normalize a bare site name or subdomain into `https://<site>.atlassian.net`. Confirm an ambiguous
custom URL with the user rather than guessing it.

Collect the email and API token through a durable Backoffice UI rather than chat. Define a workflow
and return this exact shape from a completed `step.do`, including only fields still missing:

```js
await step.do("request Jira credentials", async () => ({
  $ui: {
    version: 1,
    state: { response: { siteUrl: "", email: "", apiToken: "" } },
    spec: {
      root: "form",
      elements: {
        form: {
          type: "Stack",
          props: { gap: "md" },
          children: ["site-url", "email", "api-token", "submit"],
        },
        "site-url": {
          type: "TextInput",
          props: {
            label: "Jira site URL",
            description: "For example, https://example.atlassian.net.",
            value: { $bindState: "/response/siteUrl" },
            required: true,
          },
          children: [],
        },
        email: {
          type: "TextInput",
          props: {
            label: "Atlassian account email",
            value: { $bindState: "/response/email" },
            required: true,
          },
          children: [],
        },
        "api-token": {
          type: "TextInput",
          props: {
            label: "Atlassian API token",
            description: "Use an API token, not your Atlassian password.",
            value: { $bindState: "/response/apiToken" },
            required: true,
            secret: true,
          },
          children: [],
        },
        submit: {
          type: "WorkflowEventButton",
          props: {
            label: "Connect Jira",
            eventType: "jira.credentials-submitted",
            payload: { $state: "/response" },
          },
          children: [],
        },
      },
    },
  },
}));

const credentials = await step.waitForEvent("Jira credentials", {
  type: "jira.credentials-submitted",
});
```

Use `credentials.payload.apiToken` only inside later `step.do` calls. Keep it out of workflow
output, tool summaries, issue content, and prose.

**Complete when** the workflow has received the site URL, email, and API token through
`jira.credentials-submitted`.

## 3. Connect Jira Cloud

Create or replace the connection with Basic authentication. The username is the Atlassian account
email and the password is the API token:

```js
await api.createConnection({
  slug: "jira",
  name: "Jira",
  baseUrl: siteUrl,
  auth: {
    type: "basic",
    username: email,
    password: apiToken,
  },
});
```

Treat the API token as a secret: use the exact submitted value only in the tool call. Never echo it
or substitute a placeholder credential.

Verify stored authentication first with `api.getAuthStatus({ slug: "jira" })`. Then prove Jira API
access with:

```js
await api.request({
  slug: "jira",
  method: "GET",
  path: "/rest/api/3/myself",
  headers: { Accept: "application/json" },
  body: { type: "empty" },
  timeoutMs: 30000,
});
```

Require HTTP 200 and confirm the returned account email or display name with the user. On HTTP 401,
ask for a fresh API token and confirm that the email belongs to the token owner. On HTTP 404,
recheck the Jira site URL.

**Complete when** auth is active and `/rest/api/3/myself` returns the intended account.

## 4. Discover projects and issue types

Inspect Jira before choosing where or what to create. List accessible projects with:

```js
await api.request({
  slug: "jira",
  method: "GET",
  path: "/rest/api/3/project/search",
  query: { maxResults: "50", startAt: "0" },
  headers: { Accept: "application/json" },
  body: { type: "empty" },
  timeoutMs: 30000,
});
```

Use the user's named project when it resolves uniquely. If multiple projects remain plausible, show
their keys and names and ask the user to choose. Do not silently choose an example project.

Discover the selected project's issue types before creating an issue. Prefer a non-subtask type
whose name matches the request; use `Task` for an ordinary actionable ticket when available. Ask
when the choice changes the meaning materially, such as `Bug` versus `Feature`.

**Complete when** one project key and one valid issue type are selected.

## 5. Create issues

Create an issue with `POST /rest/api/3/issue`. Jira Cloud descriptions use Atlassian Document Format
rather than a plain string:

```js
await api.request({
  slug: "jira",
  method: "POST",
  path: "/rest/api/3/issue",
  headers: { Accept: "application/json", "Content-Type": "application/json" },
  body: {
    type: "json",
    value: {
      fields: {
        project: { key: projectKey },
        issuetype: { id: issueTypeId },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: description }],
            },
          ],
        },
      },
    },
  },
  timeoutMs: 30000,
});
```

Use a concise imperative summary and preserve the user's intent in the description. Include only
fields known to be valid for the selected project and issue type. Treat HTTP 201 as success, then
report the returned issue key, summary, project, and type. Build the browse URL from the configured
base URL and returned key; never expose the API token.

**Complete when** Jira returns HTTP 201 and an issue key.

## 6. Operate on existing issues

Use the Jira issue key exactly as supplied or discovered.

- Read: `GET /rest/api/3/issue/{issueKey}`.
- Search: use Jira's current issue-search endpoint with explicit fields and bounded pagination.
- Update fields: `PUT /rest/api/3/issue/{issueKey}` with a JSON `fields` object.
- Add comments: `POST /rest/api/3/issue/{issueKey}/comment` with an Atlassian Document Format body.
- Discover transitions: `GET /rest/api/3/issue/{issueKey}/transitions`.
- Transition: `POST /rest/api/3/issue/{issueKey}/transitions` with
  `{ "transition": { "id": transitionId } }`.

Discover valid transition IDs immediately before transitioning. Ask the user to choose when several
transitions plausibly match. For every mutation, require the endpoint's documented success status
and summarize only the fields that actually changed.

**Complete when** Jira confirms the requested operation or the actionable upstream error is
reported.

## Request rules

Every `api.request` call uses a path relative to the Jira connection's base URL and includes a
`body`, including `body: { type: "empty" }` for GET requests. Treat Jira 4xx and 5xx responses as
upstream response data: report Jira's error messages without credentials, response headers, or
unrelated account data.
