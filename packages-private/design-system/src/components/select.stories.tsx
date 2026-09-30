import { useState } from "react";

import { Select } from "./select";

export default { title: "Controls/Select" };

const MODEL_OPTIONS = [
  { value: "anthropic::opus", label: "Claude Opus", description: "ANTHROPIC" },
  { value: "anthropic::sonnet", label: "Claude Sonnet", description: "ANTHROPIC" },
  { value: "openai::gpt", label: "GPT", description: null },
];

export function Default() {
  const [value, setValue] = useState(MODEL_OPTIONS[0].value);

  return (
    <div className="max-w-sm">
      <Select
        label="Model"
        name="modelOption"
        options={MODEL_OPTIONS}
        placeholder="No model available"
        value={value}
        onValueChange={setValue}
      />
    </div>
  );
}

export function Empty() {
  return (
    <div className="max-w-sm">
      <Select
        label="Model"
        name="modelOption"
        options={[]}
        placeholder="No model available"
        value=""
        onValueChange={() => {}}
      />
    </div>
  );
}
