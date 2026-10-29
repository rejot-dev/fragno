import { useState } from "react";

import { CausalFlameGraph } from "../causal-flame-graph";
import type {
  CausalFlameNode,
  CausalFlameStatus,
  CausalFlameTiming,
} from "../causal-flame-graph-model";
import { LandingSection } from "./landing-section";

const T0 = Date.UTC(2026, 9, 28, 9, 12, 0);
const s = (seconds: number) => T0 + seconds * 1000;
const at = (seconds: number): CausalFlameTiming => ({ kind: "instant", at: s(seconds) });
const ran = (from: number, to: number): CausalFlameTiming => ({
  kind: "span",
  activity: "work",
  queuedAt: s(from),
  startedAt: s(from),
  endedAt: s(to),
});

function node(
  id: string,
  kind: CausalFlameNode["kind"],
  label: string,
  timing: CausalFlameTiming,
  fields: { detail?: string; status?: CausalFlameStatus; children?: CausalFlameNode[] } = {},
): CausalFlameNode {
  return {
    id,
    kind,
    label,
    detail: fields.detail ?? null,
    status: fields.status ?? "ok",
    timing,
    children: fields.children ?? [],
  };
}

// The contact-form answer from the homepage demo, followed through everything it set in motion:
// the run that waited for someone to approve the reply, and a run whose HubSpot call failed.
const LEAD_TRACE = node("response", "event", "forms · response.submitted", at(0), {
  detail: "Contact form · Maya Chen",
  children: [
    node("route:qualify", "route", "Qualify new leads", at(0.15), {
      detail: "Started a run",
      children: [
        node("qualify-lead", "workflow", "qualify-lead", ran(0.2, 254), {
          children: [
            node("qualify/classify", "step", "classify request", at(1.8)),
            node("qualify/announce", "step", "announce lead", at(2.1)),
            node("lead-qualified", "event", "leads · lead.qualified", at(2.1), {
              detail: "fired by qualify-lead",
              children: [
                node("route:notify", "route", "Tell sales on Slack", at(2.2), {
                  detail: "Started a run",
                  children: [
                    node("notify-sales", "workflow", "notify-sales", ran(2.3, 4.2), {
                      children: [
                        node("notify/compose", "step", "compose message", at(3.4)),
                        node("notify/send", "step", "post to #sales", at(4.1)),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            node("qualify/review", "step", "review reply", at(2.4)),
            node("qualify/decision", "step", "wait for your decision", {
              kind: "span",
              activity: "wait",
              queuedAt: s(2.4),
              startedAt: s(2.4),
              endedAt: s(252),
            }),
            node("qualify/reply", "step", "send reply by email", at(253)),
          ],
        }),
      ],
    }),
    node("route:hubspot", "route", "Copy to HubSpot", at(0.16), {
      detail: "Started a run",
      children: [
        node("sync-hubspot", "workflow", "sync-hubspot", ran(0.25, 1.6), {
          status: "failed",
          children: [
            node("hubspot/create", "step", "create HubSpot contact", at(1.5), {
              status: "failed",
              detail: "HubSpot answered 502",
            }),
          ],
        }),
      ],
    }),
  ],
});

/** Shows the record every event leaves behind: what it caused, step by step, replayable. */
export function LandingAuditTrail() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);

  return (
    <LandingSection
      id="landing-audit-trail"
      title="Know why everything happened."
      visual={
        // The trace is a time axis that needs width, so phones scroll it rather than squeeze it. It is
        // relative so the graph's visually hidden labels stay inside it instead of widening the page.
        <div className="backoffice-scroll relative overflow-x-auto border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)]">
          <div className="min-w-[760px] p-4 sm:p-6">
            <CausalFlameGraph
              title="Contact form answered"
              root={LEAD_TRACE}
              selectedId={selectedId}
              emphasizedId={null}
              onSelect={setSelectedId}
              cursor={cursor}
              onCursorChange={setCursor}
              replaySpeed={1}
              playWhenVisible={true}
              surface="flush"
            />
          </div>
        </div>
      }
    >
      Every event keeps a trace of the routes it matched, the workflows it started, each step they
      ran, and who answered when one asked. Replay a run as it happened, follow one event across
      workflows, and see exactly where a run failed.
    </LandingSection>
  );
}
