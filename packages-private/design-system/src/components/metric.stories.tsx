import { Metric } from "./metric";
import { BACKOFFICE_STATUS_TONES } from "./status-light";

export default { title: "Data/Metric" };

export function Tones() {
  return (
    <div className="grid max-w-4xl gap-3 sm:grid-cols-3">
      {BACKOFFICE_STATUS_TONES.map((tone) => (
        <Metric key={tone} tone={tone} label={tone} value="1,284" detail="+12% this week" />
      ))}
    </div>
  );
}

export function WithoutDetail() {
  return (
    <div className="max-w-56">
      <Metric tone="muted" label="Success rate" value="99.8%" />
    </div>
  );
}
