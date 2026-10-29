import { useState, type SubmitEvent } from "react";

import { cn } from "../../cn";
import { Button } from "../button";
import { DataTable } from "../data-table";
import { Field } from "../field";
import { Icon } from "../icon";
import { KeyValueList } from "../key-value-list";
import { Select } from "../select";
import { BackofficeStatusLight } from "../status-light";
import { TextArea } from "../text-area";
import { LandingSection } from "./landing-section";

type Decision = "approve" | "reject";

type StepState = "done" | "waiting" | "pending";

const DECISIONS = [
  { label: "Approve and pay", value: "approve" },
  { label: "Send back to supplier", value: "reject" },
] as const;

/**
 * Shows a workflow that stops to ask, with the form it generated for that one question; sending
 * the answer lets the run continue.
 */
export function LandingGenerativeUi() {
  const [decision, setDecision] = useState<Decision | null>("approve");
  const [sent, setSent] = useState(false);

  function send(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (decision !== null) {
      setSent(true);
    }
  }

  const steps: readonly { label: string; state: StepState }[] = [
    { label: "read invoice INV-2041", state: "done" },
    { label: "match to purchase order", state: "done" },
    { label: "ask for approval", state: sent ? "done" : "waiting" },
    { label: decision === "reject" ? "reply to supplier" : "schedule payment", state: "pending" },
  ];

  return (
    <LandingSection
      id="landing-generative-ui"
      title="Forms made for the question at hand."
      visual={
        <div className="grid border border-[color:var(--bo-border)] bg-[var(--bo-panel)] shadow-[var(--bo-panel-shadow)] lg:grid-cols-[0.34fr_0.66fr]">
          <div className="border-b border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] p-5 lg:border-r lg:border-b-0">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-[11px] text-[var(--bo-muted)]">
                approve-invoice.workflow.js
              </span>
            </div>
            <div className="mt-3">
              <BackofficeStatusLight tone={sent ? "live" : "waiting"} role="status">
                {sent ? "Running" : "Waiting for you"}
              </BackofficeStatusLight>
            </div>
            <ol className="mt-5 space-y-3">
              {steps.map((step) => (
                <li key={step.label} className="flex items-center gap-3 text-sm">
                  <StepMark state={step.state} />
                  <span className={cn(step.state === "pending" && "text-[var(--bo-muted-2)]")}>
                    {step.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <form onSubmit={send} className="space-y-5 p-5 sm:p-6">
            <div>
              <h3 className="text-xl font-semibold tracking-[-0.02em]">Approve invoice INV-2041</h3>
              <p className="mt-1 text-sm text-[var(--bo-muted)]">
                Two lines differ from the purchase order.
              </p>
            </div>
            <KeyValueList
              columns={2}
              items={[
                { key: "supplier", label: "Supplier", value: "Brightline Supplies" },
                { key: "amount", label: "Amount", value: "€1,240.00" },
              ]}
            />
            <DataTable
              caption="Lines that differ"
              columns={[
                { key: "item", label: "Item", align: "start" },
                { key: "ordered", label: "Ordered", align: "end" },
                { key: "invoiced", label: "Invoiced", align: "end" },
              ]}
              rows={[
                { item: "Nitrile gloves, box", ordered: "40", invoiced: "48" },
                { item: "Delivery", ordered: "€0.00", invoiced: "€35.00" },
              ]}
            />
            <Field label="Decision" required>
              <Select
                options={DECISIONS}
                value={decision}
                disabled={sent}
                onValueChange={setDecision}
              />
            </Field>
            <Field label="Note for the record">
              <TextArea
                rows={2}
                disabled={sent}
                defaultValue="Extra gloves were agreed by phone."
              />
            </Field>
            <Button variant="accent" type="submit" disabled={sent || decision === null}>
              {sent ? "Decision sent" : "Send decision"}
            </Button>
          </form>
        </div>
      }
    >
      When a workflow needs a decision or details from you, it asks with a form built for that
      moment, showing exactly what you need to decide. Your answer goes straight back to the waiting
      run.
    </LandingSection>
  );
}

function StepMark({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className="grid size-5 shrink-0 place-items-center bg-emerald-500/10 text-[var(--bo-live)]">
        <Icon name="check" className="size-3" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "size-5 shrink-0 border",
        state === "waiting"
          ? "border-[color:var(--bo-waiting)] bg-[var(--bo-waiting-bg)]"
          : "border-dashed border-[color:var(--bo-border-strong)]",
      )}
    />
  );
}
