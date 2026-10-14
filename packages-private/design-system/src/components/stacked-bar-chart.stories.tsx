import { StackedBarChart } from "./stacked-bar-chart";

export default { title: "Data/Stacked bar chart" };

const series = [
  { id: "github", label: "github" },
  { id: "codemode", label: "codemode" },
  { id: "telegram", label: "telegram" },
];

const hourlyVolume = [4, 0, 0, 1, 12, 30, 22, 8, 3, 0, 0, 5, 9, 14, 6, 2, 0, 0, 1, 7, 18, 11, 4, 2];

export function HourlyEvents() {
  return (
    <div className="max-w-2xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <StackedBarChart
        ariaLabel="Events per hour over the last 24 hours"
        series={series}
        buckets={hourlyVolume.map((github, hour) => ({
          id: String(hour),
          label: `${String(hour).padStart(2, "0")}:00`,
          values: { github, codemode: hour % 3, telegram: hour % 5 === 0 ? 2 : 0 },
        }))}
      />
    </div>
  );
}

export function Empty() {
  return (
    <div className="max-w-2xl border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4">
      <StackedBarChart
        ariaLabel="No events"
        series={[]}
        buckets={hourlyVolume.map((_, hour) => ({
          id: String(hour),
          label: `${String(hour).padStart(2, "0")}:00`,
          values: {},
        }))}
      />
    </div>
  );
}
