import { useId, useState } from "react";

import { CheckboxField, Field, type FieldDensity } from "./field";
import { Input } from "./input";
import { Select } from "./select";
import { TextArea } from "./text-area";

export default { title: "Controls/Field" };

const DECISIONS = [
  { label: "Approve", value: "approve" },
  { label: "Reject", value: "reject" },
];

function FieldSet({ density }: { density: FieldDensity }) {
  const id = useId();
  const [name, setName] = useState("");
  const [decision, setDecision] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="flex w-80 flex-col gap-4">
      <code className="font-mono text-xs font-semibold">density="{density}"</code>
      <Field
        controlId={`${id}-name`}
        density={density}
        label="Name"
        description="Shown on the receipt."
        required
        error={null}
      >
        <Input
          id={`${id}-name`}
          density={density}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="w-full"
        />
      </Field>
      <Field
        controlId={`${id}-decision`}
        density={density}
        label="Decision"
        description={undefined}
        required={false}
        error={null}
      >
        <Select
          controlId={`${id}-decision`}
          density={density}
          options={DECISIONS}
          value={decision}
          placeholder="Choose an option"
          disabled={false}
          required={false}
          onValueChange={setDecision}
        />
      </Field>
      <Field
        controlId={`${id}-reason`}
        density={density}
        label="Reason"
        description={undefined}
        required={false}
        error="Enter at least 10 characters."
      >
        <TextArea
          id={`${id}-reason`}
          density={density}
          rows={3}
          aria-invalid
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <CheckboxField
        controlId={`${id}-confirmed`}
        density={density}
        label="I confirm this operation"
        description="The workflow continues once you submit."
        required
        disabled={false}
        checked={confirmed}
        error={null}
        onCheckedChange={setConfirmed}
      />
    </div>
  );
}

export function Densities() {
  return (
    <div className="flex flex-wrap items-start gap-10">
      <FieldSet density="compact" />
      <FieldSet density="default" />
      <FieldSet density="comfortable" />
    </div>
  );
}
