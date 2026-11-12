# Syncing External Data

A **feed** keeps a connected service's data current inside Backoffice as events, so pages, routes,
and agents read it like any other event. A scheduled route starts one run per occurrence; the run
fetches, compares each record with its checkpoint, and fires an event for each record that changed.

## Steps

1. **Define the events.** Name a `source` for the service, such as `bank`, and one event type per
   kind of record, such as `balance.updated`, `account-transaction.changed`, and
   `card-transaction.changed`. A kind is what the service's ids are unique within: a bank whose
   account and card transactions may share an id fires them as two types. Create each with
   `events.catalogCreate`, giving a payload schema and `keyPath: "$.entityId"`. Every payload
   carries the record's `entityId`, the service's id, a `version` that counts its changes, and the
   `record`'s values, including its `kind`. The key path makes the `event_state` relation keep each
   record's latest event: its current state, which pages read. **Complete when** `events.catalogGet`
   returns each type with its `keyPath`.
2. **Save the workflow** in `/workspace/automations/`, one step per stage:

   ```js
   import { fetchRecords } from "/workspace/automations/bank-feed.js";

   // The bank's ids are unique within a kind of record, so each kind has a type of its own.
   const EVENT_TYPES = {
     balance: "balance.updated",
     account: "account-transaction.changed",
     card: "card-transaction.changed",
   };

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
         const eventType = EVENT_TYPES[record.kind];
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
   can fire one record twice at the same version; the record's state keeps the later of the two,
   which holds the same values. Fingerprint only the fields the record shows, so a changing
   timestamp the page never reads fires nothing.

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

`/static/skills/building-pages/examples/bank-accounts.page.js` reads this feed: each account and
transaction as it is now from `event_state`, and what the feed fired recently from `events`. The
feed's health comes from the relations too: its latest run from `runs` by `remoteWorkflowName`, and
its next occurrence from `route_schedules` by the route's id.
