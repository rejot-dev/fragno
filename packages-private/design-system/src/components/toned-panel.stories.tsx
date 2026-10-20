import { KeyValueList } from "./key-value-list";
import { BACKOFFICE_STATUS_TONES } from "./status-light";
import { TonedPanel } from "./toned-panel";

export default { title: "Layout/Toned panel" };

export function Tones() {
  return (
    <div className="grid max-w-4xl gap-3 sm:grid-cols-2">
      {BACKOFFICE_STATUS_TONES.map((tone) => (
        <TonedPanel key={tone} tone={tone} label={tone}>
          <p className="text-xs text-[var(--bo-fg)]">Related report content.</p>
        </TonedPanel>
      ))}
    </div>
  );
}

export function WithoutLabel() {
  return (
    <div className="max-w-xl">
      <TonedPanel tone="muted">
        <KeyValueList
          columns={2}
          items={[
            { key: "environment", label: "Environment", value: "Production" },
            { key: "region", label: "Region", value: "us-east-1" },
          ]}
        />
      </TonedPanel>
    </div>
  );
}
