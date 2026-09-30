import { useState } from "react";

import { ByteUnitField, TimeUnitField } from "./unit-fields";
import { formatBytes } from "./units";

export default { title: "Forms/Unit fields" };

export function Bytes() {
  const [value, setValue] = useState("52428800");
  return (
    <div className="max-w-sm space-y-2">
      <ByteUnitField name="maxSize" label="Max upload size" value={value} onChange={setValue} />
      <p className="text-xs text-[var(--bo-muted)]">
        Stored: {value} bytes ({formatBytes(Number(value))})
      </p>
    </div>
  );
}

export function Time() {
  const [value, setValue] = useState("900");
  return (
    <div className="max-w-sm space-y-2">
      <TimeUnitField
        name="timeout"
        label="Timeout"
        hint="How long a run may take before it is cancelled."
        value={value}
        onChange={setValue}
      />
      <p className="text-xs text-[var(--bo-muted)]">Stored: {value} seconds</p>
    </div>
  );
}
