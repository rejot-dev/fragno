# Event State

An event type's **state** is what each thing its events are about is now. For a type whose
definition has a `keyPath`, such as `$.entityId`, each event stored replaces the state of its key: a
copy of the latest event with that key, kept after the events themselves. Pages and site Workers
read it from the `event_state` relation. Agents read named keys with
`events.stateGet({ source, eventType, keys })`, up to 50 at a time, and a type's every key with
`events.stateList`, a page at a time. Each state names the `keyPath` that read its key.

State is a **view** of what the type's events said: it follows each event moments after the event is
stored, and any caller that may fire the type's events, with `events.emit`, changes it. Show things
from it, and decide from the source that owns the fact, such as whether work is going from its
workflow run. One run per thing is a keyed run:
`/static/skills/building-automations/references/keyed-runs.md`.

## Key paths

- **Choose** the field naming the thing an event is about, unique within its type, such as an
  account's or a TODO's id. Give each kind of thing one type, and fire the whole thing with every
  change, so the latest event holds all of it. Where a service's ids are unique only within a kind,
  such as account and card transactions, each kind is a type of its own: a key path names one field.
- **Set it** as `events.catalogCreate` creates the type. Events stored before the type had a key
  path stay out of its state.
- **Refusals:** an event without a string or number at the key path is refused, so `events.fire` and
  a site Worker's `fire` throw.
- **Order:** a key's state takes an event only when it occurred later than the one it holds, so a
  late delivery leaves newer state in place.
- **Lasting:** a key's state stays until it is deleted, however long its events are kept. A type
  grows a row per thing, such as one per transaction a feed syncs. Fire a removal as the thing's
  latest event, such as `{ action: "delete", todo }`, leave those out where the state is read, and
  delete the states that must go, as Delete state describes.
- **Built-in types:** Backoffice keys its own events. `pi` events key on `$.agentName`, and pages
  read agents from the `agents` relation; `integrations` connection events key on `$.connectionId`,
  read from `connections`; `sandbox` `instance.ready`, `instance.stopped`, and `instance.failed` key
  on `$.sandboxId`, and a sandbox's lifecycle is the latest of its three; `automations`
  `route.failed` keys on `$.route.id`, each route's latest failure, as `event-routing.md` describes.

## Change a key path

Changing a type's key path, or deleting its definition, leaves the state as it is: the states read
with the old key path stay beside the new ones until you delete them. Their payloads are the copy
that lasts, as old events may be gone, so fill the new state from them before deleting them.

1. **Change it** with
   `events.catalogUpdate({ source, eventType, patch: { keyPath: "$.productId" } })`. A package's
   type changes only when the package is installed again. **Complete when** `events.catalogGet`
   returns the new `keyPath`.
2. **Fill it again** by firing each old state's `payload` again, so the new key path reads its key.
   A fired event is the latest, so skip things that changed since and have a state under the new key
   path already. Firing again runs the type's routes: read `router.list` for routes on the type
   first, and ask the user before firing where a route does more than keep data, such as starting a
   workflow per request.

   ```js
   async () => {
     const type = { source: "warehouse", eventType: "stock.changed" };
     const { keyPath } = await events.catalogGet(type);
     const keyOf = (payload) =>
       String(
         keyPath
           .split(".")
           .slice(1)
           .reduce((value, field) => value?.[field], payload),
       );
     const old = [];
     const current = new Set();
     let cursor;
     do {
       const page = await events.stateList({ ...type, cursor });
       for (const state of page.states) {
         if (state.keyPath === keyPath) current.add(state.key);
         else old.push(state);
       }
       cursor = page.hasNextPage ? page.nextCursor : undefined;
     } while (cursor);
     const stale = old.filter((state) => !current.has(keyOf(state.payload)));
     for (const state of stale) {
       await events.fire({ ...type, payload: state.payload });
     }
     return { fired: stale.length };
   };
   ```

   A feed can instead fetch every record again: delete its checkpoints, such as the `store` keys
   `store.list({ prefix: "bank:entity:" })` returns, then run its route with `router.triggerNow`, as
   `/static/skills/building-automations/references/syncing-external-data.md` describes. Events from
   a site or an installed app fire only from it, so their old states stay until each thing changes;
   meanwhile read only the states with the type's `keyPath`. **Complete when** each thing an old
   state holds also has a state under the new key path, or the user knows which stay old.

3. **Delete the old states,** at most 50 keys per call. After a deleted definition, the type's
   states are all old.

   ```js
   async () => {
     const type = { source: "warehouse", eventType: "stock.changed" };
     const { keyPath } = await events.catalogGet(type);
     const old = [];
     let cursor;
     do {
       const page = await events.stateList({ ...type, cursor });
       old.push(...page.states.filter((state) => state.keyPath !== keyPath));
       cursor = page.hasNextPage ? page.nextCursor : undefined;
     } while (cursor);
     const deleted = [];
     for (let i = 0; i < old.length; i += 50) {
       const keys = old.slice(i, i + 50).map((state) => state.key);
       deleted.push(...(await events.stateDelete({ ...type, keys })).deleted);
     }
     return { deleted: deleted.length };
   };
   ```

   **Complete when** `events.stateList` lists no state with another `keyPath`.

## Delete state

`events.stateDelete({ source, eventType, keys })` deletes the state of keys, such as a removed
type's or one thing's that must go for good. Deleting is permanent: events are history and may be
gone, so a key's state starts again only with its next event. Deleting needs `events.manage`.
