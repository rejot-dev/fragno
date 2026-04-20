# Bash Runtime Review

1. **[P1] `apps/backoffice/app/fragno/bash-runtime/bash-host.ts:235-243`**  
   `executeBashAutomation()` mounts fixed global paths (`/context` and `/dev`) onto the passed
   `MasterFileSystem` and skips mounting when those paths already exist. That makes the helper
   non-reentrant: if two runs overlap on the same filesystem instance, the second run will read the
   first run’s `/context/event.json`, and then the first run’s `finally` block will unmount paths
   the second run is still using. This can happen anywhere a shared
   `automationFileSystem`/interactive FS is reused, and it causes cross-run event leakage plus
   mid-run failures. Use per-execution mount namespaces or a cloned filesystem instead of shared
   fixed mount points.

2. **[P1] `apps/backoffice/app/fragno/bash-runtime/telegram-bash-runtime.ts:475-501`**  
   `telegram.file.download` never checks the `Response` status before consuming the body. When
   Telegram returns a 4xx/5xx (bad `fileId`, expired attachment, backend outage), the command will
   still write the error payload to stdout or `--output` and exit `0`, so downstream automation
   steps treat a failed download as a valid attachment. This should fail fast on non-2xx responses
   before reading or writing any bytes.

3. **[P2] `apps/backoffice/app/fragno/bash-runtime/bash-host.ts:325-359,384-395`**  
   The nested runtime behind `automations.script.run` is rebuilt from the raw event file, but the
   interactive host only injects `orgId` into `createEventBashRuntime()` and never passes a
   `createPiAutomationContext`. Because `runScript()` only requires `id/source/eventType`, a
   dashboard/Pi user can run a script with a minimal event fixture and unexpectedly lose
   `pi.session.*`; if the fixture omits `orgId`, they also lose `telegram.*`, `resend.*`, and
   `reson8.*` as “not configured”, even though those commands exist in the parent shell. This
   parent/child context drift is a real reuse bug; the nested context should be hydrated from
   `input.orgId` and the existing Pi runtime, not just the event file.

4. **[P2] `apps/backoffice/app/fragno/bash-runtime/automations-bash-runtime.ts:110-128`**  
   The concurrent-insert retry path for `bindAutomationIdentityActor()` falls back to matching
   `error.message` substrings like `"duplicate"` and `"unique constraint"`. That makes correctness
   depend on adapter-specific wording, so a driver/version change can silently disable the retry and
   turn normal concurrent binds into surfaced failures. Given the repo’s error-handling guidance,
   this should key off stable error codes/types only, with message parsing removed or normalized at
   a lower layer.

**Overall verdict:** needs attention

## Human Reviewer Callouts (Non-Blocking)

- (none)
