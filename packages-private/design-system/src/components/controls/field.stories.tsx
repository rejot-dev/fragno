import { useState } from "react";

import { Checkbox } from "./checkbox";
import { CheckboxField, Field } from "./field";
import type { FieldDensity } from "./field-density";
import { FileInput } from "./file-input";
import { Input } from "./input";
import { Select } from "./select";
import { TextArea } from "./text-area";

export default { title: "Controls/Field" };

const DECISIONS = [
  { label: "Approve", value: "approve" },
  { label: "Reject", value: "reject" },
];

function FieldSet({ density }: { density: FieldDensity }) {
  const [name, setName] = useState("");
  const [decision, setDecision] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  return (
    <div className="flex w-80 flex-col gap-4">
      <code className="font-mono text-xs font-semibold">density="{density}"</code>
      <Field density={density} label="Name" description="Shown on the receipt." required>
        <Input
          density={density}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="w-full"
        />
      </Field>
      <Field density={density} label="Decision">
        <Select
          density={density}
          options={DECISIONS}
          value={decision}
          onValueChange={setDecision}
        />
      </Field>
      <Field density={density} label="Reason" error="Enter at least 10 characters.">
        <TextArea
          density={density}
          rows={3}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <Field density={density} label="Attachment" description="PDF or image, up to 10 MB.">
        <FileInput density={density} accept="application/pdf,image/*" />
      </Field>
      <CheckboxField
        density={density}
        label="I confirm this operation"
        description="The workflow continues once you submit."
        required
        checked={confirmed}
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

export function Choices() {
  return (
    <form className="w-80">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-[var(--bo-fg)]">Permissions</legend>
        <Checkbox name="permission" value="files.read" defaultChecked>
          files.read
        </Checkbox>
        <Checkbox name="permission" value="files.write">
          files.write
        </Checkbox>
        <Checkbox name="permission" value="admin" disabled>
          admin
        </Checkbox>
      </fieldset>
      <fieldset className="mt-4 grid grid-cols-3 gap-2">
        <legend className="mb-2 text-sm font-semibold text-[var(--bo-fg)]">Capture</legend>
        <Checkbox appearance="card" density="compact" name="capture" value="record" defaultChecked>
          Record
        </Checkbox>
        <Checkbox appearance="card" density="compact" name="capture" value="lab">
          Lab
        </Checkbox>
        <Checkbox appearance="card" density="compact" name="capture" value="targets">
          Targets
        </Checkbox>
      </fieldset>
    </form>
  );
}
