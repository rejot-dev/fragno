import { ProgressMeter } from "./progress-meter";
import { BACKOFFICE_STATUS_TONES } from "./status-tone";

export default { title: "Data/Progress meter" };

export function Tones() {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      {BACKOFFICE_STATUS_TONES.map((tone, index) => (
        <ProgressMeter
          key={tone}
          tone={tone}
          label={`${tone} import`}
          percent={(index + 1) * 20}
          detail={`${(index + 1) * 20} of 100 records`}
        />
      ))}
    </div>
  );
}

export function Bounds() {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <ProgressMeter tone="muted" label="Not started" percent={0} />
      <ProgressMeter tone="live" label="Clamped above 100" percent={140} />
    </div>
  );
}
