# Subprocessors

**Last updated: 13 November 2026**

ReJot Nederland B.V. uses the service providers below to operate Leyway. Depending on the service, a
provider processes data we control, such as account and analytics data, Customer Data we process for
our customers, or both. Each processes personal data only to provide its service to us, under a
written agreement. We will update this page before adding a new subprocessor. To be notified of
changes, email leyway-privacy@rejot.dev.

## Infrastructure and hosting

| Subprocessor                             | Purpose                                       | Data involved                                                                  | Location                                                                     | Transfer safeguard |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------ |
| Cloudflare, Inc. (Durable Objects, R2)   | Storage of workspaces                         | Workspace databases, files and published sites                                 | Your chosen storage region (EU or US); any region with no preference         | SCCs; DPF          |
| Cloudflare, Inc. (Durable Objects)       | Storage of account records                    | Account data, sign-in sessions, organization memberships, marketplace listings | One location for all of Leyway, not tied to your storage region              | SCCs; DPF          |
| Cloudflare, Inc. (Workers)               | Running the application and handling requests | All data in transit                                                            | Cloudflare's global network, near the user                                   | SCCs; DPF          |
| Cloudflare, Inc. (Containers)            | Workspace computers and their snapshots       | Files and commands in workspace computers                                      | Currently near the requesting user, which may be outside your storage region | SCCs; DPF          |
| Cloudflare, Inc. (Browser Run)           | Loading web pages for agents                  | URLs and page content requested by agents                                      | Cloudflare's global network                                                  | SCCs; DPF          |
| Cloudflare, Inc. (Workers Observability) | Logs, traces and error alerts                 | Technical data, request metadata                                               | Not published by Cloudflare                                                  | SCCs; DPF          |

## AI models and transcription

| Subprocessor                            | Purpose                                                            | Data involved                               | Location                                                     | Transfer safeguard |
| --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| OpenAI Ireland Ltd (OpenAI API)         | AI models for agents, data extraction and image generation         | Content sent to the model                   | United States (global API endpoint)                          | SCCs               |
| Anthropic Ireland, Limited (Claude API) | AI models (Claude)                                                 | Content sent to the model                   | Stored in the United States; inference may run in any region | SCCs               |
| Google LLC (Gemini API)                 | AI models (Gemini)                                                 | Content sent to the model                   | Not limited to a region                                      | SCCs; DPF          |
| Cloudflare, Inc. (Workers AI)           | AI models run by Cloudflare                                        | Content sent to the model                   | Not published by Cloudflare                                  | SCCs; DPF          |
| Resonate Labs B.V. (Reson8)             | Speech-to-text for dictation and for audio files agents transcribe | Audio and transcripts, not stored by Reson8 | Netherlands (own GPU infrastructure)                         | Not needed (EU)    |

## Communication and connections

| Subprocessor                  | Purpose                                                                | Data involved                                                            | Location                         | Transfer safeguard |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------- | ------------------ |
| Resend (Plus Five Five, Inc.) | Sending email and receiving email at Leyway inbound addresses          | Email addresses, message content, attachments, delivery logs             | United States                    | SCCs; DPF          |
| Oomol Studio Limited (OOMOL)  | Connecting workspaces to the third-party apps in its connector catalog | Connection credentials and data exchanged with apps connected through it | Singapore (company in Hong Kong) | SCCs               |

## Analytics and telemetry

| Subprocessor             | Purpose                                                                                           | Data involved                                                                                                                                                                                                   | Location            | Transfer safeguard |
| ------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------ |
| PostHog, Inc. (EU Cloud) | Product analytics and browser error reports, with consent; operational telemetry from our servers | From browsers: usage events, user ID, email, name, role, approximate location. From our servers: user, organization and workspace IDs, routes, workflow and file names, AI model usage and cost, error messages | Germany (Frankfurt) | SCCs; DPF          |

## Services you connect

Services you connect, such as GitHub, Telegram, MCP servers and third-party apps, are not our
subprocessors. You choose to connect them, and they handle data under their own terms.
