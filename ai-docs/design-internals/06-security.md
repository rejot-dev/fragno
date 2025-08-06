# 06 · Security & Privacy

## 1. Threat Model

| Asset          | Threat                                        | Mitigation                                                                          |
| -------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| OpenAI API key | Leakage via client bundles                    | Keep key server-side only. Never expose in FE adapter.                              |
| Tool execution | Malicious prompt triggers destructive actions | Tool handlers require explicit developer implementation + optional guard functions. |
| Data leakage   | Chat context may include PII                  | Redaction filters & allow-list of form fields.                                      |
| Replay attack  | Re-sending `function_call_output`             | Messages carry ULID + nonce; server verifies unknown IDs.                           |

## 2. Authentication & Authorisation

- Server route protected by host app’s existing auth.
- Optional **JWT** signature on each request for multi-tenant apps.
- Rate-limit per user (e.g., 5 chats / min, 20 tool calls / min).

## 3. Transport Security

- HTTPS mandatory.
- SSE stream uses same TLS connection; no CORS preflight with same-origin.

## 4. Dependency Audit

- `npm audit` + `socket.dev` in CI.
- Renovate bot auto-upgrades minor/patch versions.

## 5. Data Retention

- No server-side persistence by default.
- Host app chooses to store chat logs (GDPR note: requires consent if personal data).

## 6. Compliance Targets

- SOC-2 (leveraging OpenAI SOC reports).
- GDPR: DPA with OpenAI; allow EU-only endpoints.

## 7. Open Questions

- Should we sign _outgoing_ tool calls with HMAC? (prevents hijack of FE <-> BE channel)
- Need CSRF protection for non-SSE fallback? (unlikely)
