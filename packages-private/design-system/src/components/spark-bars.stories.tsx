import { SparkBars } from "./spark-bars";

export default { title: "Data/Spark bars" };

export function InATableCell() {
  return (
    <table className="text-sm text-[var(--bo-fg)]">
      <tbody>
        {[
          { name: "recivo-email-received", values: [0, 0, 2, 5, 1, 0, 0, 3] },
          { name: "telegram-user-linking", values: [1, 1, 0, 0, 0, 0, 0, 0] },
          { name: "idle-workflow", values: [0, 0, 0, 0, 0, 0, 0, 0] },
        ].map((row) => (
          <tr key={row.name}>
            <td className="py-1 pr-6">{row.name}</td>
            <td className="py-1">
              <SparkBars values={row.values} ariaLabel={`Runs of ${row.name}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
