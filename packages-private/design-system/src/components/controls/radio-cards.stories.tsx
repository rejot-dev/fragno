import { useState } from "react";

import { RadioCards } from "./radio-cards";

export default { title: "Controls/Radio cards" };

export function WorkspaceChoice() {
  const [usage, setUsage] = useState<"personal" | "organization" | "agency">("personal");

  return (
    <div className="max-w-md">
      <RadioCards
        label="How you use Backoffice"
        name="usage"
        value={usage}
        onValueChange={setUsage}
        options={[
          { value: "personal", label: "Just me", description: "Work in your own workspace." },
          {
            value: "organization",
            label: "My organization",
            description: "Share projects and automations with a team.",
          },
          {
            value: "agency",
            label: "An agency",
            description: "Run organizations for your clients.",
          },
        ]}
      />
    </div>
  );
}
