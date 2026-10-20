import { Callout } from "./callout";
import { BACKOFFICE_STATUS_TONES } from "./status-light";

export default { title: "Feedback/Callout" };

export function Tones() {
  return (
    <div className="flex max-w-xl flex-col gap-3">
      {BACKOFFICE_STATUS_TONES.map((tone) => (
        <Callout key={tone} tone={tone} title={`${tone} note`}>
          The latest provider update is still being processed.
        </Callout>
      ))}
    </div>
  );
}
