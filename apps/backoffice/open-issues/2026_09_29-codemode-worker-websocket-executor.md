# Validate the codemode bridge executor in deployment

Status: implemented locally; deployment validation pending

Created: September 29, 2026

Node Backoffice runs codemode through one authenticated WebSocket per activation to an ordinary
Worker handler in `apps/cf-sandbox-bridge`. The bridge compiles and runs guests on its Worker
Loader; every Backoffice operation returns to Node over that socket. Cloudflare Backoffice runs the
same guest runtime on its local Worker Loader. On both runtimes, immediate, module, and build
activations go through the scope's `CODEMODE` Durable Object, which records each run. The bridge
itself stays stateless: no executor Durable Object, persistence, or reconnect protocol.

Local builds, type checks, and the Node, Cloudflare, and bridge suites pass. Nothing below has been
exercised against deployed Workers.

## Open: rollout and deployed behavior

Local workerd does not prove deployed CPU enforcement or deployment-time disconnect behavior.

1. Deploy the object Worker with `pnpm --dir apps/backoffice run deploy:bootstrap`; it adds the
   `Codemode` SQLite class. Activate the web Worker immediately afterwards, because the previous web
   version binds the removed `OutboundProxy` entrypoint.
2. Deploy the bridge with its WebSocket route, `LOADER`, and private `CodemodeCompiler` entrypoint,
   and confirm Cloudflare Backoffice's `CODEMODE_COMPILER` binding resolves to it.
3. From the VPS over `wss://`, probe immediate, module, nested workflow, suspension, and
   interruption activations.
4. Prove a CPU-bound guest is terminated by the deployed CPU limit, not only by the async deadline.
5. Drop an active connection during a bridge deployment and confirm Node records interruption, not
   success, and that workflow management recovers through existing retry/failure policy.
6. Exercise bridge unavailability from the Node web and processor processes; errors must be
   actionable and there is no fallback executor.

## Open: workflows bypass the Codemode object

Workflow activations still call the bridge or local loader directly (`TODO(codemode)` in
`app/fragno/codemode/workflow-execute.ts`), so they are not recorded as runs. Moving them requires:

- one Cloudflare execution path instead of the separate `DynamicWorkerExecutor` workflow path;
- passing suspension through the object instead of failing with
  `CODEMODE_ACTIVATION_CANNOT_SUSPEND`;
- proof that step callbacks and duplicated RPC stubs survive the extra Durable Object hop.

Afterwards, codemode availability becomes "a `CODEMODE` binding is present" and
`remote-execution-host.ts` can be deleted.

## Invariants for remaining work

- Guests have no network egress (`globalOutbound: null`); internet access goes through host tools.
- Node owns authorization, runtime tools, workflow state, checkpoints, and suspension decisions.
- A lost completion is an unknown outcome. Never reconnect, replay an immediate activation, or claim
  rollback of tool effects that already ran.
