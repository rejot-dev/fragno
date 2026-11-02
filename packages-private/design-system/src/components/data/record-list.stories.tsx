import { RecordList } from "./record-list";

export default { title: "Data/Record list" };

export function Statuses() {
  return (
    <div className="max-w-xl">
      <RecordList
        items={[
          {
            key: "sync",
            title: "Daily synchronization",
            detail: "Completed 24 records.",
            status: "Live",
            tone: "live",
          },
          {
            key: "replay",
            title: "Webhook replay",
            detail: "Waiting for the scheduled retry.",
            status: "Waiting",
            tone: "waiting",
          },
          { key: "export", title: "Ledger export", status: "Failed", tone: "failed" },
          { key: "archive", title: "Archive", detail: "No status reported.", tone: "muted" },
        ]}
      />
    </div>
  );
}

export function Truncated() {
  return (
    <div className="max-w-xl">
      <RecordList
        items={[
          { key: "one", title: "First record", tone: "info" },
          { key: "two", title: "Second record", tone: "info" },
        ]}
        totalCount={80}
      />
    </div>
  );
}
