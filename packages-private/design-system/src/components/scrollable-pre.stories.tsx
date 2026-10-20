import { ScrollablePre } from "./scrollable-pre";

export default { title: "Data/Scrollable pre" };

const LONG_OUTPUT = Array.from(
  { length: 60 },
  (_, index) => `${String(index + 1).padStart(2, "0")}  invoice-${4100 + index}  paid`,
).join("\n");

export function Default() {
  return (
    <div className="max-w-2xl">
      <ScrollablePre>{LONG_OUTPUT}</ScrollablePre>
    </div>
  );
}

export function Expanded() {
  return (
    <div className="max-w-2xl">
      <ScrollablePre expanded>{LONG_OUTPUT}</ScrollablePre>
    </div>
  );
}
