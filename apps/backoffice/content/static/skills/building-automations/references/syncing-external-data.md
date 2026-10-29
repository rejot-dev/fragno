# Syncing External Data

A **feed** keeps a connected service's data current inside Backoffice as events, so pages, routes,
and agents read it like any other event. A scheduled route starts one run per occurrence; the run
fetches, compares each record with its checkpoint, and fires an event for each record that changed.

## Steps

1. **Define the events.** Name a `source` for the service, such as `bank`, and one event type per
   kind of change, such as `balance.updated`, `transaction.created`, and `transaction.updated`.
   Create each with `events.catalogCreate`, giving a payload schema. Every payload carries the
   record's `entityId`, a `version` that counts its changes, and the `record`'s values, including
   its `kind`. **Complete when** `events.catalogGet` returns each type.
2. **Save the workflow** in `/workspace/automations/`, one step per stage:

   ```js
   import { fetchRecords } from "/workspace/automations/bank-feed.js";

   export default defineWorkflow({ name: "bank-feed" }, async (event, step) => {
     const records = await step.do(
       "fetch",
       { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" } },
       fetchRecords,
     );
     const changes = await step.do("diff", async () => {
       const changed = [];
       for (const { id, record } of records) {
         const key = `bank:entity:${record.kind}:${id}`;
         const saved = await store.get({ key });
         const previous = saved ? JSON.parse(saved.value) : null;
         const fingerprint = JSON.stringify(record);
         if (previous?.fingerprint === fingerprint) continue;
         const version = (previous?.version ?? 0) + 1;
         const eventType =
           record.kind === "balance"
             ? "balance.updated"
             : previous
               ? "transaction.updated"
               : "transaction.created";
         changed.push({ key, fingerprint, version, eventType, entityId: id, record });
       }
       return changed;
     });
     for (const change of changes) {
       await step.do(`fire ${change.key} v${change.version}`, async () => {
         const { entityId, version, record, eventType } = change;
         await events.fire({ source: "bank", eventType, payload: { entityId, version, record } });
         await store.set({
           key: change.key,
           value: JSON.stringify({ fingerprint: change.fingerprint, version }),
         });
       });
     }
     return { records: records.length, fired: changes.length };
   });
   ```

   **Dedupe** lives in the checkpoints: a record fires only when its fingerprint differs from the
   stored one, and a retried run resumes after its completed steps. A step that fails after its fire
   can fire one record twice at the same version; pages read the latest event per entity, which
   absorbs it. Fingerprint only the fields the record shows, so a changing timestamp the page never
   reads fires nothing.

   **Fetch window**: the first run backfills what the page needs, such as this year. Later runs
   fetch a recent window that overlaps the last one, such as the last 30 days, so status changes on
   recent records arrive without re-reading the whole history.

   **Complete when** `js.check` reports no diagnostics.

3. **Schedule it** with a `schedule` route, such as `bank-feed-hourly`, whose `start_workflow`
   action renders a fresh instance ID per occurrence, such as `bank-feed-${event.id}`, as the
   skill's schedule example shows. Choose a cadence longer than a run takes. **Complete when**
   `router.get` returns the route.
4. **Verify.** Run the route twice with `router.triggerNow`, following the skill's verification
   step. **Complete when** the first run fires an event per record, the second fires none, and
   `events.list({ source })` shows the first run's events.

## Pages over a feed

`/static/skills/building-pages/examples/bank-accounts.page.js` reads this feed: it keeps the latest
event per `record.kind` and `entityId`, ordered by `version`. The feed's health comes from the
relations too: its latest run from `runs` by `remoteWorkflowName`, and its next occurrence from
`route_schedules` by the route's id.
