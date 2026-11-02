import {
  itemKey,
  type OrchestrationEvent,
  type OrchestrationGraph,
  type OrchestrationSource,
  type OrchestrationTarget,
} from "./orchestration-graph-model";
import { circularMean, normalizeAngle, shortestDelta, spreadAround } from "./radial-geometry";

/** An enabled route's event and the workflow it starts; parallel routes collapse into one. */
type WorkflowTrigger = { eventId: string; workflowId: string };

type Arc = { startAngle: number; endAngle: number };

/**
 * What turns a planet: per event, the angles towards the planets it is forwarded to or from; per
 * workflow, the angles of the outside systems it calls; and the angles towards neighbouring planets
 * close enough to crowd its workflows.
 */
export type WorkflowOrientation = {
  forwardBearings: ReadonlyMap<string, readonly number[]>;
  callBearings: ReadonlyMap<string, readonly number[]>;
  crowded: readonly number[];
};

/** A planet on its own, with nothing around it to face. */
export const UNORIENTED: WorkflowOrientation = {
  forwardBearings: new Map(),
  callBearings: new Map(),
  crowded: [],
};

/**
 * Angles are radians, clockwise from 12 o'clock; radii belong to the renderer. A trigger's angle
 * is where its edge leaves the event.
 */
export type WorkflowTriggerLayout = {
  sources: readonly (Arc & { source: OrchestrationSource })[];
  events: readonly (Arc & { event: OrchestrationEvent })[];
  workflows: readonly { workflow: OrchestrationTarget; angle: number }[];
  triggers: readonly (WorkflowTrigger & { sourceId: string; angle: number })[];
};

const TAU = Math.PI * 2;
const SOURCE_GAP = 0.035;
const WORKFLOW_MIN_GAP = 0.26;
const TRIGGER_EDGE_INSET = 0.04;
// A workflow may sit this far beyond each event that starts it, to turn towards what it calls.
const MIN_WORKFLOW_SWAY = 0.5;
// A workflow keeps at least this far, around its orbit, from the way to a neighbouring planet,
// where the neighbour's workflows and labels would meet its own.
const CROWDED_HALF_WIDTH = 0.55;
// How strongly a workflow turns its ring towards what it calls, against a forward's pull.
const CALL_PULL = 0.1;
// How strongly events starting the same workflow keep together, per radian between them.
const TOGETHER_PULL = 0.5;
// What two workflows leaning past each other, and so crossing their trigger edges, cost.
const CROSSING_COST = 0.5;
const RING_TURNS = 144;
const PLACE_STEPS = 360;
const RING_STEP = TAU / 120;

// An event's outputs are the workflows it starts and the scopes it is forwarded to.
type Section = {
  source: OrchestrationSource;
  events: readonly { event: OrchestrationEvent; outputs: number }[];
  weight: number;
};
/** A workflow as its ring sees it: the events starting it and the angles of what it calls. */
type RingWorkflow = { eventIds: readonly string[]; calls: readonly number[] };

/**
 * Only what starts workflows: enabled `start_workflow` routes, the events they listen to, and the
 * sources of those events. Messages to running workflows and agents are left out; forwards are
 * drawn by whatever shows the scopes they reach.
 */
function workflowTriggers(graph: OrchestrationGraph): WorkflowTrigger[] {
  const triggers = new Map<string, WorkflowTrigger>();
  for (const route of graph.routes) {
    if (route.enabled && route.action.kind === "start_workflow") {
      const trigger = { eventId: route.eventId, workflowId: route.action.targetId };
      triggers.set(JSON.stringify(trigger), trigger);
    }
  }
  return [...triggers.values()];
}

function workflowIdsByEvent(triggers: readonly WorkflowTrigger[]): Map<string, string[]> {
  const byEvent = new Map<string, string[]>();
  for (const { eventId, workflowId } of triggers) {
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), workflowId]);
  }
  return byEvent;
}

/**
 * Where an edge towards `toward` leaves an event: the point of the event's arc nearest that angle,
 * so a wide event does not send edges the long way round.
 */
export function eventDepartureAngle(arc: Arc, toward: number): number {
  const middle = (arc.startAngle + arc.endAngle) / 2;
  const halfSpan = (arc.endAngle - arc.startAngle) / 2;
  const reach = halfSpan - Math.min(TRIGGER_EDGE_INSET, halfSpan * 0.3);
  return middle + Math.max(-reach, Math.min(reach, shortestDelta(middle, toward)));
}

/** How far an angle sits from an event's arc; nothing within it. */
function apart(angle: number, arc: Arc): number {
  return Math.abs(shortestDelta(angle, eventDepartureAngle(arc, angle)));
}

function spread(angle: number, arcs: readonly Arc[]): number {
  return arcs.reduce((total, arc) => total + apart(angle, arc), 0);
}

/**
 * The spot nearest all the events starting a workflow. Two events filling the ring have opposite
 * middles, so their mean says little; the spots where they meet are nearest to both.
 */
function amid(arcs: readonly Arc[]): number {
  return [
    circularMean(arcs.map((arc) => ({ angle: (arc.startAngle + arc.endAngle) / 2, weight: 1 }))),
    ...arcs.flatMap((arc) => [(arc.startAngle + arc.endAngle) / 2, arc.startAngle, arc.endAngle]),
  ].reduce((best, angle) => (spread(angle, arcs) < spread(best, arcs) - 1e-9 ? angle : best));
}

function reaches(angle: number, arcs: readonly Arc[]): boolean {
  return arcs.every((arc) => apart(angle, arc) <= MIN_WORKFLOW_SWAY);
}

/**
 * The stretches of orbit, clockwise from `from` to `to`, where a workflow started by `arcs` may
 * sit, tried every `RING_STEP`; just the spot amid the events when none reaches them all.
 */
function reachableStretches(arcs: readonly Arc[]): { from: number; to: number }[] {
  const steps = Math.round(TAU / RING_STEP);
  const inside = Array.from({ length: steps }, (_, step) => reaches(step * RING_STEP, arcs));
  const firstOut = inside.indexOf(false);
  if (firstOut === -1) {
    return [{ from: 0, to: TAU }];
  }
  const stretches: { from: number; to: number }[] = [];
  // Walk once round from a spot outside, so no stretch is split where the walk starts.
  for (let offset = 1; offset <= steps; offset++) {
    const step = (firstOut + offset) % steps;
    if (inside[step] && !inside[(step - 1 + steps) % steps]) {
      stretches.push({ from: step * RING_STEP, to: step * RING_STEP });
    } else if (inside[step]) {
      stretches[stretches.length - 1].to = step * RING_STEP;
    }
  }
  if (stretches.length === 0) {
    const middle = amid(arcs);
    return [{ from: middle, to: middle }];
  }
  return stretches;
}

/** The angle within the stretches nearest `angle`. */
function nearestWithin(stretches: readonly { from: number; to: number }[], angle: number): number {
  let best = angle;
  let bestDistance = Infinity;
  for (const { from, to } of stretches) {
    if (normalizeAngle(angle - from) <= normalizeAngle(to - from)) {
      return angle;
    }
    for (const end of [from, to]) {
      const distance = Math.abs(shortestDelta(angle, end));
      if (distance < bestDistance) {
        best = end;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * Where on the orbit a workflow sits: within `MIN_WORKFLOW_SWAY` of every event that starts it, as
 * close as that allows to what it calls, or else amid those events, and out of the way of crowding
 * planets where it can be. Spots are tried every degree.
 */
function workflowPlace(
  arcs: readonly Arc[],
  calls: readonly number[],
  crowded: readonly number[],
): number {
  const middle = amid(arcs);
  const wanted =
    calls.length === 0 ? middle : circularMean(calls.map((angle) => ({ angle, weight: 1 })));
  const reachable = Array.from({ length: PLACE_STEPS }, (_, step) => (step / PLACE_STEPS) * TAU)
    .concat(middle)
    .filter((angle) => reaches(angle, arcs));
  if (reachable.length === 0) {
    return middle;
  }
  const crowding = (angle: number) =>
    Math.max(
      0,
      ...crowded.map((neighbour) => CROWDED_HALF_WIDTH - Math.abs(shortestDelta(neighbour, angle))),
    );
  const score = (angle: number) => crowding(angle) * TAU + Math.abs(shortestDelta(angle, wanted));
  return reachable.reduce((best, angle) => (score(angle) < score(best) - 1e-9 ? angle : best));
}

/**
 * The ring of sources and their events in order, each event spanning `unit` per output, turned by
 * `rotation`: unturned, the first source sits centred at 12 o'clock.
 */
function ringArcs(sections: readonly Section[], unit: number, rotation: number) {
  let cursor = rotation - (sections[0] ? (sections[0].weight * unit) / 2 : 0);
  const sources: (Arc & { source: OrchestrationSource })[] = [];
  const events: (Arc & { event: OrchestrationEvent })[] = [];
  for (const section of sections) {
    const sourceStart = cursor;
    for (const { event, outputs } of section.events) {
      events.push({ event, startAngle: cursor, endAngle: cursor + outputs * unit });
      cursor += outputs * unit;
    }
    sources.push({ source: section.source, startAngle: sourceStart, endAngle: cursor });
    cursor += SOURCE_GAP;
  }
  return { sources, events };
}

/**
 * Turns the ring, and reorders its sources and each source's events, so forwarded events face the
 * planets they go to or come from, and forwards leave and land on the near side; so workflows,
 * amid the events starting them, face what they call; and so those events stay close, keeping
 * trigger edges short. Without anything to face the ring stays as it is.
 */
function turnRing(
  sections: readonly Section[],
  unit: number,
  forwardBearings: ReadonlyMap<string, readonly number[]>,
  workflows: readonly RingWorkflow[],
): { sections: readonly Section[]; rotation: number } {
  const faced =
    workflows.some((workflow) => workflow.calls.length > 0) ||
    sections.some((section) =>
      section.events.some(({ event }) => (forwardBearings.get(event.id) ?? []).length > 0),
    );
  if (!faced) {
    return { sections, rotation: 0 };
  }
  const bestRotation = rotationScorer(unit, forwardBearings, workflows);
  // Each order is scored once, at its best rotation; the search comes back to orders often.
  const scored = new Map<
    string,
    { sections: readonly Section[]; rotation: number; cost: number }
  >();
  function score(candidate: readonly Section[]) {
    const key = candidate
      .map((section) => section.events.map(({ event }) => event.id).join(","))
      .join("|");
    const known = scored.get(key);
    if (known) {
      return known;
    }
    const result = { sections: candidate, ...bestRotation(candidate) };
    scored.set(key, result);
    return result;
  }
  // From the busiest-first order, take the best swap of two sources or of two events of a source,
  // while one improves the ring.
  let found = score(sections);
  for (;;) {
    const next = swaps(found.sections)
      .map(score)
      .reduce((best, candidate) => (candidate.cost < best.cost - 1e-9 ? candidate : best), found);
    if (next === found) {
      return found;
    }
    found = next;
  }
}

/** Every order one swap away: two sources trading places, or two events of one source. */
function swaps(sections: readonly Section[]): Section[][] {
  const orders: Section[][] = [];
  for (let a = 0; a < sections.length; a++) {
    for (let b = a + 1; b < sections.length; b++) {
      const order = [...sections];
      [order[a], order[b]] = [order[b], order[a]];
      orders.push(order);
    }
    const { events } = sections[a];
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        const swapped = [...events];
        [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
        orders.push(
          sections.map((section, at) => (at === a ? { ...section, events: swapped } : section)),
        );
      }
    }
  }
  return orders;
}

/** What a workflow costs at each rotation of the ring, with its events where they are. */
type WorkflowTurns = {
  id: number;
  /** How spread out its events are, which no rotation changes. */
  strain: number;
  cost: Float64Array;
  /** Where its nearest trigger edge leaves, relative to the ring, and how far round it runs. */
  spanFrom: Float64Array;
  spanLength: Float64Array;
};

/**
 * Finds the rotation of an order of the ring that costs least, tried every `RING_TURNS`th of a
 * turn. Orders one swap apart leave most events where they were, so what each workflow and each
 * forwarded event costs at every rotation, and where two workflows cross, is tabulated once per
 * place on the ring and shared by every order that keeps them there.
 */
function rotationScorer(
  unit: number,
  forwardBearings: ReadonlyMap<string, readonly number[]>,
  workflows: readonly RingWorkflow[],
): (sections: readonly Section[]) => { rotation: number; cost: number } {
  const workflowTables = new Map<string, WorkflowTurns>();
  const forwardTables = new Map<string, Float64Array>();
  // The rotations at which two workflows, by table id, cross their trigger edges.
  const crossingTables = new Map<string, readonly number[]>();

  function forwardTurns(arc: Arc & { event: OrchestrationEvent }): Float64Array {
    const key = `${arc.event.id}|${arc.startAngle}`;
    const known = forwardTables.get(key);
    if (known) {
      return known;
    }
    const table = new Float64Array(RING_TURNS);
    for (const angle of forwardBearings.get(arc.event.id) ?? []) {
      for (let step = 0; step < RING_TURNS; step++) {
        const rotation = (step / RING_TURNS) * TAU;
        table[step] += 1 - Math.cos(eventDepartureAngle(arc, angle - rotation) + rotation - angle);
      }
    }
    forwardTables.set(key, table);
    return table;
  }

  function workflowTurns(index: number, own: readonly Arc[]): WorkflowTurns {
    const key = `${index}|${own.map((arc) => arc.startAngle).join(",")}`;
    const known = workflowTables.get(key);
    if (known) {
      return known;
    }
    const { calls } = workflows[index];
    const middle = amid(own);
    const stretches = reachableStretches(own);
    const facing = circularMean(calls.map((angle) => ({ angle, weight: 1 })));
    const table: WorkflowTurns = {
      id: workflowTables.size,
      strain: TOGETHER_PULL * spread(middle, own),
      cost: new Float64Array(RING_TURNS),
      spanFrom: new Float64Array(RING_TURNS),
      spanLength: new Float64Array(RING_TURNS),
    };
    for (let step = 0; step < RING_TURNS; step++) {
      const rotation = (step / RING_TURNS) * TAU;
      // A workflow sits as near what it calls as its events let it.
      const sit = calls.length === 0 ? middle : nearestWithin(stretches, facing - rotation);
      for (const angle of calls) {
        table.cost[step] += CALL_PULL * (1 - Math.cos(sit + rotation - angle));
      }
      // Its trigger edge spans the orbit from where it leaves its nearest event to the workflow.
      let leaves = sit;
      let nearest = Infinity;
      for (const arc of own) {
        const angle = eventDepartureAngle(arc, sit);
        const distance = Math.abs(shortestDelta(angle, sit));
        if (distance < nearest) {
          leaves = angle;
          nearest = distance;
        }
      }
      const delta = shortestDelta(leaves, sit);
      table.spanFrom[step] = delta >= 0 ? leaves : sit;
      table.spanLength[step] = Math.abs(delta);
    }
    workflowTables.set(key, table);
    return table;
  }

  // Workflows leaning past each other cross their trigger edges, and crossing spans interleave.
  function crossings(a: WorkflowTurns, b: WorkflowTurns): readonly number[] {
    const key = `${a.id}|${b.id}`;
    const known = crossingTables.get(key);
    if (known) {
      return known;
    }
    const steps: number[] = [];
    for (let step = 0; step < RING_TURNS; step++) {
      const from = normalizeAngle(b.spanFrom[step] - a.spanFrom[step]);
      const to = normalizeAngle(b.spanFrom[step] + b.spanLength[step] - a.spanFrom[step]);
      if (from <= a.spanLength[step] !== to <= a.spanLength[step]) {
        steps.push(step);
      }
    }
    crossingTables.set(key, steps);
    return steps;
  }

  return (sections) => {
    const arcs = ringArcs(sections, unit, 0).events;
    const arcOf = new Map(arcs.map((arc) => [arc.event.id, arc]));
    const turns = workflows.map((workflow, index) =>
      workflowTurns(
        index,
        workflow.eventIds.flatMap((id) => {
          const arc = arcOf.get(id);
          return arc ? [arc] : [];
        }),
      ),
    );
    const total = new Float64Array(RING_TURNS).fill(
      turns.reduce((sum, { strain }) => sum + strain, 0),
    );
    const add = (table: Float64Array) => {
      for (let step = 0; step < RING_TURNS; step++) {
        total[step] += table[step];
      }
    };
    for (const arc of arcs) {
      if (forwardBearings.has(arc.event.id)) {
        add(forwardTurns(arc));
      }
    }
    for (const { cost } of turns) {
      add(cost);
    }
    for (let a = 0; a < turns.length; a++) {
      for (let b = a + 1; b < turns.length; b++) {
        for (const step of crossings(turns[a], turns[b])) {
          total[step] += CROSSING_COST;
        }
      }
    }
    let found = { rotation: 0, cost: Infinity };
    for (let step = 0; step < RING_TURNS; step++) {
      if (total[step] < found.cost - 1e-9) {
        found = { rotation: (step / RING_TURNS) * TAU, cost: total[step] };
      }
    }
    return found;
  };
}

/**
 * `forwardCounts` is how many other scopes each event is forwarded to. Forwarded events take part
 * like events that start workflows, so every edge that leaves the scope has an event to leave from.
 */
export function layoutWorkflowTriggerGraph(
  graph: OrchestrationGraph,
  forwardCounts: ReadonlyMap<string, number>,
  orientation: WorkflowOrientation,
): WorkflowTriggerLayout {
  const byEvent = workflowIdsByEvent(workflowTriggers(graph));
  const outputCount = (event: OrchestrationEvent) =>
    (byEvent.get(event.id)?.length ?? 0) + (forwardCounts.get(event.id) ?? 0);

  const sections: Section[] = graph.sources
    .map((source) => {
      const events = graph.events
        .filter((event) => event.sourceId === source.id && outputCount(event) > 0)
        .sort(
          (left, right) =>
            outputCount(right) - outputCount(left) || left.eventType.localeCompare(right.eventType),
        )
        .map((event) => ({ event, outputs: outputCount(event) }));
      return {
        source,
        events,
        weight: events.reduce((weight, { outputs }) => weight + outputs, 0),
      };
    })
    .filter((section) => section.events.length > 0)
    .sort(
      (left, right) =>
        right.weight - left.weight || left.source.label.localeCompare(right.source.label),
    );

  const totalWeight = sections.reduce((weight, section) => weight + section.weight, 0);
  const unit = totalWeight === 0 ? 0 : (TAU - sections.length * SOURCE_GAP) / totalWeight;
  const ringWorkflows = [...new Set([...byEvent.values()].flat())].map((workflowId) => ({
    eventIds: [...byEvent]
      .filter(([, workflowIds]) => workflowIds.includes(workflowId))
      .map(([eventId]) => eventId),
    calls: orientation.callBearings.get(workflowId) ?? [],
  }));
  const turned = turnRing(sections, unit, orientation.forwardBearings, ringWorkflows);
  const { sources, events } = ringArcs(turned.sections, unit, turned.rotation);

  // Each workflow sits among the events that start it, leaning towards the outside systems it
  // calls and away from crowding planets as far as those events reach, so its trigger edges stay
  // short and its calls leave on the side they go to. Then neighbours are pushed apart.
  const startingArcs = new Map<string, Arc[]>();
  for (const arc of events) {
    for (const workflowId of byEvent.get(arc.event.id) ?? []) {
      startingArcs.set(workflowId, [...(startingArcs.get(workflowId) ?? []), arc]);
    }
  }
  const started = graph.targets.filter((target) => startingArcs.has(target.id));
  const workflowAngles = spreadAround(
    started.map((workflow) =>
      workflowPlace(
        startingArcs.get(workflow.id) ?? [],
        orientation.callBearings.get(workflow.id) ?? [],
        orientation.crowded,
      ),
    ),
    WORKFLOW_MIN_GAP,
  );
  const workflows = started.map((workflow, index) => ({ workflow, angle: workflowAngles[index] }));
  const workflowAngle = new Map(workflows.map(({ workflow, angle }) => [workflow.id, angle]));

  const triggers = events.flatMap((arc) =>
    (byEvent.get(arc.event.id) ?? []).map((workflowId) => ({
      eventId: arc.event.id,
      sourceId: arc.event.sourceId,
      workflowId,
      angle: eventDepartureAngle(arc, workflowAngle.get(workflowId) ?? 0),
    })),
  );

  return { sources, events, workflows, triggers };
}

export type WorkflowTriggerItem = { kind: "source" | "event" | "target"; id: string };

/** What an item starts and what starts it, as `itemKey`s, the item included. */
export function relatedWorkflowTriggerItems(
  layout: WorkflowTriggerLayout,
  item: WorkflowTriggerItem,
): Set<string> {
  const related = new Set([itemKey(item)]);
  for (const { sourceId, eventId, workflowId } of layout.triggers) {
    const involved =
      (item.kind === "source" && item.id === sourceId) ||
      (item.kind === "event" && item.id === eventId) ||
      (item.kind === "target" && item.id === workflowId);
    if (involved) {
      related.add(itemKey({ kind: "source", id: sourceId }));
      related.add(itemKey({ kind: "event", id: eventId }));
      related.add(itemKey({ kind: "target", id: workflowId }));
    }
  }
  return related;
}
