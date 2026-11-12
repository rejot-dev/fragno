# Event State

An event type's **state** is what each thing its events are about is now. For a type whose
definition has a `keyPath`, such as `$.entityId`, each event stored replaces the state of its key: a
copy of the latest event with that key, kept after the events themselves. Pages and site Workers
read it from the `event_state` relation; `events.stateList` lists it. Each state names the `keyPath`
that read its key.

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
- **Removed things:** a state stays until it is deleted. Fire a removal as the thing's latest event,
  such as `{ action: "delete", todo }`, and leave those out where the state is read.

## Change a key path

Changing a type's key path, or deleting its definition, leaves the state as it is: the states read
with the old key path stay beside the new ones until you delete them.

1. **Change it** with
   `events.catalogUpdate({ source, eventType, patch: { keyPath: "$.productId" } })`. A package's
   type changes only when the package is installed again. **Complete when** `events.catalogGet`
   returns the new `keyPath`.
2. **Delete the old states.** Page through the state and delete each key read with another key path,
   at most 50 keys per call. After a deleted definition, the type's states are all old.

   ```js
   async () => {
     const type = { source: "warehouse", eventType: "stock.changed" };
     const { keyPath } = await events.catalogGet(type);
     const stale = [];
     let cursor;
     do {
       const page = await events.stateList({ ...type, cursor });
       stale.push(...page.states.filter((state) => state.keyPath !== keyPath));
       cursor = page.hasNextPage ? page.nextCursor : undefined;
     } while (cursor);
     const deleted = [];
     for (let i = 0; i < stale.length; i += 50) {
       const keys = stale.slice(i, i + 50).map((state) => state.key);
       deleted.push(...(await events.stateDelete({ ...type, keys })).deleted);
     }
     return { deleted: deleted.length };
   };
   ```

   **Complete when** `events.stateList` lists no state with another `keyPath`.

3. **Fill it again.** Each new event fills its key's state. Things that change rarely need firing
   again, as their latest values:
   - a feed fires every record again once its checkpoints are gone: delete its `store` keys, such as
     those `store.list({ prefix: "bank:entity:" })` returns, then run its route with
     `router.triggerNow`, as
     `/static/skills/building-automations/references/syncing-external-data.md` describes;
   - other sources fire each thing's latest event again with `events.fire`.

   Firing again runs the type's routes again. Read `router.list` for routes on the type first, and
   ask the user before firing again where a route does more than keep data, such as starting a
   workflow per request. **Complete when** `events.stateList` holds a state for each thing the
   type's pages and sites show, or the user knows which stay empty until they change.

## Delete state

`events.stateDelete({ source, eventType, keys })` deletes the state of keys, such as a removed
type's or one thing's that must go for good; their events stay in `events`, and a key's next event
starts its state again. Deleting needs `events.manage`.
