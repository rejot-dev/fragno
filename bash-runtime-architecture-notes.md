# Bash Runtime Architecture Notes

## Scope reviewed

Cross-referenced against:

- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`
- `apps/backoffice/app/fragno/bash-runtime/automations-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/event-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/pi-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/resend-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/reson8-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/telegram-bash-runtime.ts`
- `apps/backoffice/app/fragno/automation/commands/bash-adapter.ts`
- `apps/backoffice/app/fragno/automation/engine/bash.ts`
- tests in `apps/backoffice/app/fragno/bash-runtime/*.test.ts` and
  `apps/backoffice/app/fragno/automation/engine/bash.test.ts`

## Short verdict

The per-runtime design is still mostly good:

- runtime files are understandable in isolation
- command specs/help are usually colocated with handlers
- the shared command adapter is useful for normal structured commands

The main weakness is now the **composition model**, not the individual runtimes:

- host assembly is too manual
- route-backed runtime plumbing is duplicated and inconsistent
- special-case commands bypass shared behavior
- execution isolation is too implicit
- the current `automations.script.run` behavior has drifted away from the actual product intent

So the architecture is not bad, but some cleanup decisions are now clear enough that they should be
encoded directly in the design.

---

## What is confirmed to be working well

### 1. Runtime-local command definitions are mostly clean

The main pattern is consistent in several runtimes:

- define specs + help in the runtime file
- parse CLI args there
- register through `createAutomationCommands(...)`
- keep transport/backend details inside a runtime object

This is visible in:

- `pi-bash-runtime.ts`
- `resend-bash-runtime.ts`
- `automations-bash-runtime.ts`
- `event-bash-runtime.ts`

### 2. Capability gating is explicit

`createBashHost()` only exposes command families when their context is present. Tests in
`bash-host.test.ts` verify this.

That means the command surface is not half-configured; missing capabilities simply do not register.

### 3. The shared command adapter is useful for normal structured commands

`apps/backoffice/app/fragno/automation/commands/bash-adapter.ts` centralizes:

- `--help`
- parse/execute flow
- stdout/stderr/exitCode normalization
- command call logging

That path is worth keeping for structured commands.

---

## Confirmed architectural weaknesses

### 1. Host assembly is too manual

Confirmed.

`bash-host.ts` hardcodes:

- the `BashHostContext` shape
- `EMPTY_BASH_HOST_CONTEXT`
- command registration order in `createBashHost()`
- interactive wiring in `createInteractiveBashHost()`

And `createPiBashCommandContext()` in `apps/backoffice/app/fragno/pi/pi.ts` also has to know the
full interactive runtime set.

### Example

```ts
customCommands: [
  ...createAutomationsBashCommands(commandInput),
  ...createOtpBashCommands(commandInput),
  ...createEventBashCommands(commandInput),
  ...createPiBashCommands(commandInput),
  ...createReson8BashCommands(commandInput),
  ...createResendBashCommands(commandInput),
  ...createTelegramBashCommands(commandInput),
];
```

This is simple, but it is also a central registry that grows every time a new capability is added.

---

### 2. Route-backed runtime plumbing is duplicated

Confirmed, with 2 transport styles already present.

#### Pattern A: append `orgId` to a synthetic route URL

Used by:

- `pi-bash-runtime.ts`
- `automations-bash-runtime.ts`

#### Pattern B: use an org-scoped Durable Object stub directly

Used by:

- `resend-bash-runtime.ts`
- `reson8-bash-runtime.ts`
- `telegram-bash-runtime.ts`

Even with those differences, the duplicated bits are obvious:

- `isSuccessStatus(...)`
- JSON error-field extraction helpers
- `throwOnRouteError(...)`
- inconsistent `NOT_CONFIGURED` handling

The duplication is not identical, but it is substantial enough that behavior is already drifting.

---

### 3. The command model is split between structured commands and custom raw commands

Confirmed.

Primary path:

- `createAutomationCommands(...)`
- spec-driven parsing/help/output handling

Escape hatch path:

- `defineCommand(...)`
- direct shell FS access / custom binary-ish output / custom write behavior

Verified examples:

- `telegram.file.download` uses a custom command
- `reson8.prerecorded.transcribe` uses a custom command

Important nuance:

- `telegram.file.download` is custom-only
- `reson8.prerecorded.transcribe` is effectively double-represented: it still appears in the shared
  spec list, while the structured handler just throws and the custom command handles the real work

This split is tolerable in small doses, but it is already a source of inconsistency.

---

### 4. Context composition is wide and centrally owned

Confirmed.

`BashHostContext` currently owns:

- `automation`
- `automations`
- `otp`
- `pi`
- `reson8`
- `resend`
- `telegram`

And `AutomationBashHostContext` mirrors much of that shape again in the automation engine.

That gives clear capability gating, but it also means:

- the host knows too much about every module
- every new runtime expands shared types
- composition logic can drift between interactive and automation contexts

So the issue is not that the typing is weak; it is that ownership of composition sits in central
host code.

---

### 5. Execution isolation is too implicit

Confirmed.

`executeBashAutomation()` mutates the passed `MasterFileSystem` by mounting:

- `/context`
- `/dev`

and skips mounting when those mount points already exist.

That behavior is tested in `automation/engine/bash.test.ts`.

### Why this is a real problem

Multiple users can be logged into the system at once, so the runtime should be concurrency-safe.
That means fixed shared mount points on a shared filesystem instance are not a good contract.

If two runs overlap on the same `MasterFileSystem`:

1. run A mounts `/context`
2. run B sees it already mounted and reuses it
3. run B can observe run A's state
4. run A unmounts it while run B is still running

Even if many call sites happen to serialize today, the implementation itself is not safely
reentrant.

---

## Confirmed correctness problems

### 1. `telegram.file.download` does not check the response status

Confirmed in `telegram-bash-runtime.ts`.

The command:

- calls `downloadFile(...)`
- immediately reads `response.arrayBuffer()`
- writes bytes to stdout or `--output`
- exits `0`

It never checks whether the response was successful.

### Why this matters

An error response body can be treated as a successful file download.

### Example

```bash
telegram.file.download --file-id bad-id -o /workspace/file.bin
```

This can currently succeed while writing an error payload into the output file.

---

### 2. Shared mount mutation is non-reentrant

Confirmed in `executeBashAutomation()`.

Because `/context` and `/dev` are fixed shared mount points on the passed filesystem, the current
execution model is not safe under overlapping use of the same `MasterFileSystem`.

This should be treated as a real bug-risk, not just a cleanliness issue.

---

## Product/design decisions now clarified

These decisions are now clear enough to stop treating them as open questions.

### 1. `automations.script.run` is really an interactive testing tool

The actual intent is:

- a user is already in an interactive shell context
- they provide an event file
- they want to test whether an automation behaves correctly for that event

So this is **not** a general nested-runtime model.

Architecturally, that means the current name and behavior are misleading.

### Recommended direction

Rename:

- `automations.script.run` -> `scripts.run`

And treat it as:

- interactive-only
- a test/debug utility
- not part of real automation execution semantics

---

### 2. Parent org should always be inherited in interactive `scripts.run`

There are 2 distinct contexts that should not be conflated.

#### Real automation execution

A real event arrives, possibly with an `orgId`, and that event determines which org runtime is
spawned for execution.

#### Interactive `scripts.run`

A human is already inside an interactive org context and picks an event fixture to test with. In
that case:

- the parent interactive org determines the runtime
- the event file is input data, not authority for selecting a different runtime

### Recommended direction

In interactive `scripts.run`:

- always inherit parent `orgId`
- inherit parent org-scoped capabilities consistently
- the event file should not silently switch runtime scope

A useful consistency rule would be:

- if the event file omits `orgId`, inherit the parent org
- if the event file includes `orgId` and it matches the parent org, allow it
- if it includes a different `orgId`, fail clearly

That preserves the production mental model without letting fixtures unexpectedly change runtime
scope.

---

### 3. We should not model this as “nested runs”

Also clarified.

If `scripts.run` is an interactive test harness command, then the architecture should stop treating
it as recursive automation execution.

That means:

- no conceptual support for automations spawning other automations as a first-class runtime model
- no accidental inheritance/reconstruction logic designed around recursive execution
- no exposure of this command inside real automation execution contexts

### Recommended direction

`scripts.run` should be available only in interactive hosts and unavailable from
automation-triggered shell execution.

---

### 4. Binary support should not drive the architecture

Clarified.

There is no need to redesign the whole command system around “binary support” as a first-class
feature.

Instead:

- keep the structured command system focused on normal command behavior
- keep special cases small and isolated
- fix existing custom-command bugs directly

So the right response is not “generalize the entire framework for binaries”, but “do not let a few
special commands distort the main architecture”.

---

### 5. Generic errors are fine

Clarified.

No need for per-runtime typed `NotConfiguredError` hierarchies.

Recommended direction:

- standardize on a generic error policy
- normalize wording and status handling consistently across runtimes
- avoid runtime-specific exception taxonomies unless a real caller needs them

---

## Concrete examples from the current codebase

### Example: automation runtime exposes `/context/event.json`

Verified in `automation/engine/bash.test.ts`:

```bash
printf "event=%s\n" "$(cat /context/event.json)"
```

This is a nice script-authoring feature, but its current implementation depends on global mount
points.

### Example: Telegram download bypasses the structured adapter

Verified in `telegram-bash-runtime.ts`:

```bash
telegram.file.download --file-id "$file_id" -o /workspace/photo.jpg
```

This needs custom FS-aware behavior, but it currently misses the usual response-status
normalization.

### Example: Pi commands stay on the structured path

Verified in `pi-bash-runtime.ts`:

```bash
pi.session.create --agent assistant --name support --print id
pi.session.turn --session-id session-123 --text "Hello" --print assistantText
```

These are easier to reason about because they stay inside the shared parse/help/output path.

### Example: current script-run behavior mixes inheritance rules

Today the nested script-runner logic partially inherits the parent org/runtime and partially
rebuilds from the event file.

That mixed model is exactly what should be removed by redefining the command as interactive-only
`scripts.run` with explicit parent-org inheritance.

---

## Recommended refactor direction

### 1. Rename `automations.script.run` to `scripts.run`

Reason:

- the current name suggests nested automation execution
- the actual intent is interactive testing/debugging

### 2. Make `scripts.run` interactive-only

Reason:

- this is a shell/debug utility, not part of automation runtime semantics
- it should not be exposed inside automation-triggered executions

### 3. In `scripts.run`, always inherit parent org and capability scope

Reason:

- interactive users already chose an org context
- fixtures should not silently change runtime scope

### 4. Fail clearly if an interactive event fixture claims a different `orgId`

Reason:

- prevents confusing cross-org fixture use
- keeps the distinction between real execution and interactive simulation clear

### 5. Make execution isolation concurrency-safe

Reason:

- multiple users may be active at once
- fixed shared mount points are not a safe basis for execution isolation

### 6. Extract shared route-runtime helpers

At minimum:

- success-status helpers
- JSON error extraction helpers
- generic error normalization
- possibly a small route-caller helper layer for the 2 existing transport styles

### 7. Keep custom commands minimal; do not redesign the framework around binary support

Reason:

- special cases exist, but they should remain special cases
- fix the Telegram download bug directly instead of broadening the abstraction prematurely

### 8. Move toward a module/capability registration model for host assembly

Reason:

- reduce central host churn
- move capability ownership closer to each runtime module

---

## Bottom line

Updated overall take:

- **runtime-level design is still good enough**
- **system composition is the real weak point**
- **execution isolation needs to be concurrency-safe**
- **`automations.script.run` should be reframed as interactive-only `scripts.run`**
- **interactive script testing should always inherit the parent org/runtime**
- **we should stop thinking in terms of nested automation runs**

If refactoring incrementally, the best order looks like:

1. fix `telegram.file.download` status handling
2. rename/reframe `automations.script.run` to interactive-only `scripts.run`
3. enforce parent-org inheritance for interactive script testing
4. make execution mounts isolated/reentrant
5. extract shared route-runtime error helpers
6. reduce manual host assembly via a module/capability model

---

## Concrete implementation checklist

This is the practical checklist I would use to land the design in the current codebase.

### Phase 1: fix the confirmed correctness bug first

#### 1.1 Fix `telegram.file.download` to fail on non-2xx responses

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/telegram-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/telegram-bash-runtime.test.ts`

**Changes:**

- In `createTelegramDownloadCommand(...)`, check the `Response` before calling
  `response.arrayBuffer()`.
- For non-success statuses, surface a normal command failure instead of writing the response body as
  a file.
- Reuse the existing Telegram error-extraction conventions where possible, rather than inventing a
  download-only error shape.

**Tests to add/update:**

- download exits non-zero on a `404` response
- `--output` does not write a file on failure
- stdout stays empty on failure
- stderr contains a useful Telegram error message

---

### Phase 2: rename and re-scope `automations.script.run`

#### 2.1 Rename the command surface from `automations.script.run` to `scripts.run`

**Files:**

- `apps/backoffice/app/fragno/automation/commands/types.ts`
- `apps/backoffice/app/fragno/automation/commands/specs/automations.ts`
- `apps/backoffice/app/fragno/bash-runtime/automations-bash-runtime.ts`
- `apps/backoffice/app/fragno/automation/scenario.ts`
- tests in `apps/backoffice/app/fragno/automation/engine/bash.test.ts`

**Changes:**

- Update `AUTOMATIONS_COMMANDS` and `ParsedCommandByName` in `commands/types.ts`.
- Replace the spec/help text in `specs/automations.ts` so the command name and description reflect
  interactive script testing, not nested automation execution.
- Update the handler key in `automations-bash-runtime.ts`.
- Update the simulation error in `automation/scenario.ts`.
- Rename test cases and command invocations in `automation/engine/bash.test.ts`.

**Text changes worth making explicitly:**

- summary should say this runs a script against an event fixture in an interactive shell context
- examples should use `scripts.run ...`, not `automations.script.run ...`

#### 2.2 Decide where `scripts.run` should live conceptually

There are 2 plausible implementation paths:

1. keep it physically in the existing automations command group for now, but rename the command to
   `scripts.run`
2. move it into its own command group later

**Recommendation:** do **(1)** first to minimize churn, then reconsider after the behavior is fixed.

---

### Phase 3: make `scripts.run` interactive-only

#### 3.1 Remove `scriptRunner` from real automation execution context

**Files:**

- `apps/backoffice/app/fragno/automation/definition.ts`
- `apps/backoffice/app/fragno/automation/engine/bash.ts`
- `apps/backoffice/app/fragno/bash-runtime/automations-bash-runtime.ts`

**Current issue:**

`automation/definition.ts` currently creates a `scriptRunner` and passes it into
`createAutomationBashCommandContext(...)`, which makes the command available inside real automation
execution.

**Changes:**

- Stop constructing `scriptRunner` in `automation/definition.ts` for real automation runs.
- Stop threading `scriptRunner` through `createAutomationBashCommandContext(...)` in
  `automation/engine/bash.ts`.
- Keep `scriptRunner` wiring only in `createInteractiveBashHost(...)` in `bash-host.ts`.

**Outcome:**

- `scripts.run` exists in interactive hosts
- `scripts.run` is absent in automation-triggered runs

#### 3.2 Update tests to reflect interactive-only availability

**Files:**

- `apps/backoffice/app/fragno/automation/engine/bash.test.ts`
- `apps/backoffice/app/fragno/bash-runtime/bash-host.test.ts`

**Tests to add/update:**

- interactive host exposes `scripts.run`
- automation execution host does not expose `scripts.run`
- attempting to use it in automation execution produces command-not-found or equivalent unavailable
  behavior, depending on the chosen registration path

---

### Phase 4: enforce parent-org inheritance in interactive `scripts.run`

#### 4.1 Change the script-runner API so parent org/runtime are authoritative

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`
- possibly `apps/backoffice/app/fragno/automation/commands/types.ts`

**Current issue:**

`createScriptRunnerRuntime(...)` reads the event file and then reconstructs runtime context from the
parsed event. That is the source of the current mixed inheritance model.

**Changes:**

- Treat the event file as fixture data.
- In interactive mode, parent `orgId` should be the authority for runtime selection.
- The nested runtime used by `scripts.run` should inherit the parent interactive capability set,
  rather than rebuilding some capabilities from event-file state.

A likely implementation shape is:

- `createInteractiveBashHost(...)` creates `scriptRunner` with explicit access to the parent `orgId`
  and any parent-scoped runtimes it should reuse
- `createScriptRunnerRuntime(...)` validates or normalizes the parsed event, but does not let it
  choose a different org runtime

#### 4.2 Validate event fixture `orgId` against parent org

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`

**Changes:**

After parsing the event file inside `createScriptRunnerRuntime(...)`:

- if the event fixture omits `orgId`, inject the parent org
- if it includes the same `orgId`, allow it
- if it includes a different `orgId`, fail with a clear error

**Tests to add/update:**

- missing fixture `orgId` inherits parent org
- matching fixture `orgId` is allowed
- mismatched fixture `orgId` fails with a clear message
- `resend.*`, `reson8.*`, `telegram.*`, and `pi.session.*` stay available during `scripts.run` when
  they are available in the parent interactive host

#### 4.3 Reuse parent Pi/runtime capabilities where appropriate

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`
- `apps/backoffice/app/fragno/pi/pi.ts`

**Current issue:**

`createInteractiveBashHost(...)` currently omits `createPiAutomationContext`, so nested script runs
lose `pi.session.*`.

**Changes:**

- Reuse the parent interactive Pi capability for `scripts.run`, if the parent host has it.
- Do not derive Pi availability from the event fixture.

---

### Phase 5: make execution isolation concurrency-safe

#### 5.1 Stop relying on shared fixed mounts for per-run state

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`
- related tests in `apps/backoffice/app/fragno/automation/engine/bash.test.ts`

**Current issue:**

`executeBashAutomation()` mounts fixed `/context` and `/dev` paths directly onto the passed
`MasterFileSystem` and later unmounts them.

**Changes:**

Refactor so each execution gets isolated mount state. The exact implementation can vary, but the
contract should become:

- one run cannot observe another run's `/context/event.json`
- one run cannot unmount per-run infrastructure another run is still using

Likely approaches:

1. create a per-execution wrapper filesystem / mount namespace around the shared `MasterFileSystem`
2. clone the filesystem view for execution and dispose it after the run

**Recommendation:** prefer a wrapper or namespace approach over deep cloning if possible.

#### 5.2 Add regression tests for overlapping executions

**Files:**

- `apps/backoffice/app/fragno/automation/engine/bash.test.ts`

**Tests to add:**

- 2 overlapping runs using the same underlying `MasterFileSystem` do not leak `/context/event.json`
- cleanup of one run does not break the other run's `/dev` or context access

Even if the test has to simulate overlap with controlled async barriers, it is worth adding because
this is the core concurrency regression we want to prevent.

---

### Phase 6: normalize generic route/runtime error handling

#### 6.1 Extract shared helpers for route-backed runtimes

**Files to create or refactor around:**

- likely a new helper under `apps/backoffice/app/fragno/bash-runtime/`
- update:
  - `pi-bash-runtime.ts`
  - `resend-bash-runtime.ts`
  - `reson8-bash-runtime.ts`
  - `telegram-bash-runtime.ts`
  - optionally `automations-bash-runtime.ts`

**Changes:**

Extract helpers for things already repeated:

- `isSuccessStatus(...)`
- extracting JSON `message` / `code`
- generic route error formatting
- generic “not configured” message formatting

**Goal:**

Make all runtime errors feel the same to command callers, without building a complex typed error
hierarchy.

#### 6.2 Remove runtime-specific `NotConfiguredError` classes if they are no longer needed

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/resend-bash-runtime.ts`
- `apps/backoffice/app/fragno/bash-runtime/reson8-bash-runtime.ts`

If generic errors are sufficient, these can likely be simplified away as part of the normalization
pass.

---

### Phase 7: reduce host composition churn

#### 7.1 Introduce a small module registry for command families

**Files:**

- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`
- possibly a new file like `apps/backoffice/app/fragno/bash-runtime/modules.ts`

**Changes:**

Move from a hardcoded command list toward a small registration structure such as:

- module id
- context selector
- command factory

This does not need to be a full plugin system. A thin registry is enough if it:

- removes duplicated host assembly lists
- localizes capability registration
- reduces future central churn

#### 7.2 Consolidate interactive context creation

**Files:**

- `apps/backoffice/app/fragno/pi/pi.ts`
- `apps/backoffice/app/fragno/bash-runtime/bash-host.ts`

**Current issue:**

Interactive capability composition is currently split across:

- `createPiBashCommandContext(...)`
- `createInteractiveBashHost(...)`

**Changes:**

Push more of that ownership into a single composition path so the host and interactive context do
not drift separately.

---

### Phase 8: cleanup and docs alignment

#### 8.1 Update any scenario/simulation messaging

**Files:**

- `apps/backoffice/app/fragno/automation/scenario.ts`

If the command is renamed, error messaging and mock guidance should use `scripts.run` consistently.

#### 8.2 Grep for stale command strings and help text

**Command to run:**

```bash
rg -n "automations\.script\.run|scripts\.run" apps/backoffice/app
```

Use this to catch:

- stale examples
- simulation messages
- tests
- command mocks
- help text

#### 8.3 Run targeted validation

Per repo guidance, run relevant tests and checks after changes.

Suggested commands:

```bash
pnpm exec turbo test --filter=./apps/backoffice --output-logs=errors-only
pnpm exec turbo types:check --filter=./apps/backoffice --output-logs=errors-only
```

If package-level filtering is more precise for the touched workspace, use that.

---

## Implementation order I would actually use

1. fix Telegram download failure handling + tests
2. rename to `scripts.run` across command types/specs/handlers/tests
3. remove `scriptRunner` from real automation execution wiring
4. enforce parent-org inheritance + fixture-org validation in interactive `scripts.run`
5. add concurrency-safe execution isolation + overlap regression tests
6. normalize generic route/runtime error helpers
7. simplify host composition last
