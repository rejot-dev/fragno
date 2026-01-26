# Workflow State Flow

This document summarizes how workflow state is loaded, held, and persisted during execution.

## In-Memory State

- `RunnerState.instance`: claimed instance snapshot for this task run
- `RunnerState.stepsByKey`: cached step snapshots keyed by `stepKey`
- `RunnerState.events`: cached event list for the run
- `RunnerState.mutations`: buffered creates/updates for steps/events/logs
- `RunnerState.remoteState`: latest pause/terminal snapshot from heartbeat
- `RunnerState.remoteStateRefresh`: refresh hook that performs the lease heartbeat tx

## Database Roundtrips (Phases)

- **Tick scan**: retrieve pending + expired tasks (read-only)
- **Claim**: retrieve task + instance + steps + events → mutate task lease/status
- **Heartbeat**: retrieve task + instance → mutate lease + refresh `remoteState`
- **Commit**: mutate instance + task + buffered step/event/log writes (single mutate phase)
- **Conflict fallback** (rare): retrieve instance → mutate pause/delete + buffered writes

## State Flow (Mermaid)

```mermaid
flowchart TD
  A[Tick: retrieve pending/expired tasks] --> B{Claim task}
  B -->|retrieve task+instance+steps+events| C[Claim mutate: set processing + lease]
  B -->|noop/delete| Z[Skip task]

  C --> D[Create RunnerState from retrieved data]
  D --> E[Run workflow steps in memory]

  E --> F{Step boundary?}
  F -->|yes| G[Heartbeat refresh: retrieve task+instance → mutate lease]
  G --> H[Update remoteState snapshot]
  H --> E
  F -->|no| E

  E --> I{Workflow outcome}
  I -->|complete| J[Commit: mutate instance complete + delete task + flush buffered writes]
  I -->|pause| K[Commit: mutate instance paused + delete task + flush buffered writes]
  I -->|wait/suspend| L[Commit: mutate instance waiting + schedule task + flush buffered writes]
  I -->|error| M[Commit: mutate instance errored + delete task + flush buffered writes]

  J --> N[Done]
  K --> N
  L --> N
  M --> N
```

## State Guarantees

- All step/event/log persistence is buffered in memory and written once in the commit mutate phase.
- Pause/terminate decisions use the latest `remoteState` from the heartbeat transaction.
- Optimistic concurrency checks (`.check()`) are applied when IDs include version info.
